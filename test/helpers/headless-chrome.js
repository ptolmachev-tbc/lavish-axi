import { spawn } from "node:child_process";

function processGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

// SIGKILL is delivered asynchronously: Chrome's helper processes can keep
// writing into the profile directory for a moment after the signal is sent.
// A caller that removes the profile during that window fails with ENOTEMPTY,
// so settle only once every process in Chrome's group is gone.
async function waitForProcessGroupExit(pgid, exited, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const timedOut = () => new Error(`Chrome process group ${pgid} did not exit in time`);
  let leaderTimer;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        leaderTimer = setTimeout(() => reject(timedOut()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(leaderTimer);
  }
  while (processGroupAlive(pgid)) {
    if (Date.now() > deadline) throw timedOut();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Run headless Chrome with `--dump-dom` until the dumped document closes,
 * then kill Chrome and wait for its whole process group to exit, so the
 * caller can safely delete the profile directory afterwards.
 *
 * @param {string} chrome
 * @param {string[]} args
 * @param {{ timeoutMs: number, maxBytes: number, exitTimeoutMs?: number }} options
 * @returns {Promise<string>}
 */
export function dumpChromeDom(chrome, args, { timeoutMs, maxBytes, exitTimeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const exited = new Promise((resolveExit) => {
      child.once("exit", resolveExit);
      child.once("error", resolveExit);
    });
    let stdout = "";
    let settled = false;
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      const groupExit = child.pid ? waitForProcessGroupExit(child.pid, exited, exitTimeoutMs) : Promise.resolve();
      groupExit.then(
        () => (error ? reject(error) : resolve(stdout)),
        (exitError) => reject(error ?? exitError),
      );
    };
    const timer = setTimeout(() => finish(new Error("Chrome did not dump the fixture DOM in time")), timeoutMs);
    child.on("error", finish);
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`Chrome exited before dumping the fixture DOM (${code})`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBytes) {
        finish(new Error(`Chrome fixture DOM exceeded ${maxBytes} bytes`));
      } else if (stdout.includes("</html>")) {
        finish();
      }
    });
  });
}
