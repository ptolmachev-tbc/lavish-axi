import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

// The page reports, in its own text, what is selected after each mouseup and what was selected when
// a copy ran, so the accessibility snapshot shows both without reading the system clipboard.
const ARTIFACT_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>e2e-selection</title></head>
<body style="background:#fff;color:#111">
<h1 id="start">Selection start</h1>
<p id="end">Selection end.</p>
<p id="selected">Nothing selected</p>
<p id="copied">Nothing copied</p>
<script>
function selectedText() {
  return String(document.getSelection()).replace(/\\s+/g, " ").trim();
}
document.addEventListener("mouseup", function () {
  setTimeout(function () {
    document.getElementById("selected").textContent = "Selected: " + selectedText();
  }, 50);
});
document.addEventListener("copy", function () {
  document.getElementById("copied").textContent = "Copied: " + selectedText();
});
</script>
</body>
</html>
`;

test(
  "a text selection offers Copy and Comment, and Copy copies the live selection",
  { skip: !runBrowserE2e, timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-selection-e2e-"));
    const port = await freePort();
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-selection-e2e-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const browser = (...args) => run("chrome-devtools-axi", args, chromeEnv);
    function lineOf(snapshot, pattern) {
      const line = snapshot.split("\n").find((entry) => pattern.test(entry));
      assert.ok(line, `${pattern} missing from snapshot:\n${snapshot}`);
      return line;
    }
    const uidOf = (snapshot, pattern) => lineOf(snapshot, pattern).trim().split(/\s+/)[0].replace(/^uid=/, "");

    try {
      const artifact = path.join(temp, "selection.html");
      await writeFile(artifact, ARTIFACT_HTML);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      browser("open", url);
      browser("wait", "Nothing copied");
      const page = browser("snapshot");
      browser("drag", `@${uidOf(page, /"Selection start"/)}`, `@${uidOf(page, /"Selection end\."/)}`);
      browser("wait", "Selected: ");

      const selected = browser("snapshot");
      const selectedText = lineOf(selected, /"Selected: /).match(/"Selected: ([^"]+)"/)?.[1];
      assert.ok(selectedText, `the drag selected no text:\n${selected}`);
      assert.match(selected, /button "Copy"/);
      assert.match(selected, /button "Comment"/);
      assert.doesNotMatch(selected, /Annotate text/, "the selection must not open the card by itself");

      const copied = browser("click", `@${uidOf(selected, /button "Copy"/)}`);
      assert.match(copied, /button "Copied"/, copied);
      assert.ok(copied.includes(`"Copied: ${selectedText}"`), `Copy did not copy the selection:\n${copied}`);
      assert.doesNotMatch(copied, /Annotate text/, "Copy must not open the card");

      const commenting = browser("click", `@${uidOf(copied, /button "Comment"/)}`);
      assert.match(commenting, /"Annotate text"/, commenting);
      assert.match(
        commenting,
        /textbox "Tell the agent what to change about this text\.\.\."[^\n]*focused/,
        commenting,
      );
      assert.doesNotMatch(commenting, /button "Copy"/, "Comment replaces the toolbar with the card");
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true, maxRetries: 10 });
    }
  },
);
