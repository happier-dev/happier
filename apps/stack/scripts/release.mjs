import { spawnSync } from "node:child_process";
import { resolveCommandInvocation } from "./utils/process/resolveCommandInvocation.mjs";

function run(cmd, args) {
  const invocation = resolveCommandInvocation({ command: cmd, args, env: process.env });
  const result = spawnSync(invocation.command, invocation.args, {
    stdio: "inherit",
    ...(process.platform === "win32"
      ? { windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : null),
  });
  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status !== 0) process.exit(result.status);
}

function usageAndExit() {
  // Keep this very short; this is an internal dev script.
  console.error("Usage: npm run release -- <patch|minor|major>");
  console.error("");
  console.error("Options:");
  console.error("  --no-git    Skip git commit/tag (allows dirty working tree).");
  console.error("  --dry-run   Run npm publish with --dry-run.");
  process.exit(2);
}

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const noGit = args.includes("--no-git");
const dryRun = args.includes("--dry-run");

const bump = args.find((a) => ["patch", "minor", "major"].includes(a));
if (!bump) usageAndExit();

// Ensure we're authenticated before doing anything that creates a version commit/tag.
const whoamiInvocation = resolveCommandInvocation({ command: "npm", args: ["whoami"], env: process.env });
const whoami = spawnSync(whoamiInvocation.command, whoamiInvocation.args, {
  stdio: "ignore",
  ...(process.platform === "win32"
    ? { windowsHide: true, windowsVerbatimArguments: whoamiInvocation.windowsVerbatimArguments }
    : null),
});
if (typeof whoami.status === "number" && whoami.status !== 0) {
  run("npm", ["login"]);
}

if (!noGit) {
  // `npm version` makes a git commit + tag by default; it requires a clean working tree.
  const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (typeof status.status === "number" && status.status === 0) {
    const out = (status.stdout ?? "").trim();
    if (out.length > 0) {
      console.error("Refusing to version: git working tree is not clean.");
      console.error("`npm version` creates a commit + tag, so it requires a clean tree.");
      console.error("Commit/stash your changes, or re-run with --no-git if you accept publishing uncommitted files.");
      process.exit(1);
    }
  }

  run("npm", ["version", bump, "-m", "chore(release): %s"]);
} else {
  // Allow dirty working trees by skipping commit/tagging.
  run("npm", ["version", bump, "--no-git-tag-version", "--force"]);
}

run("npm", ["publish", ...(dryRun ? ["--dry-run"] : [])]);
