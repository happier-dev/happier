import test from "node:test";
import assert from "node:assert/strict";

import { maybeTrackSentryRelease, resolveSentryCliPath, resolveSentryProjects, shouldTrackSentryRelease } from "./track-release.mjs";

test("resolveSentryCliPath uses node_modules/.bin", () => {
  assert.match(resolveSentryCliPath({ repoRoot: "/repo", platform: "darwin" }), /\/repo\/node_modules\/\.bin\/sentry-cli$/);
  assert.match(resolveSentryCliPath({ repoRoot: "/repo", platform: "win32" }), /sentry-cli\.cmd$/);
});

test("resolveSentryProjects defaults when env missing", () => {
  assert.deepEqual(resolveSentryProjects({}), ["happier-server", "happier-ui"]);
});

test("shouldTrackSentryRelease requires token + release and is CI-gated by default", () => {
  assert.deepEqual(shouldTrackSentryRelease({ env: {}, release: "sha" }), { enabled: false, reason: "missing SENTRY_AUTH_TOKEN" });
  assert.deepEqual(
    shouldTrackSentryRelease({ env: { SENTRY_AUTH_TOKEN: "t" }, release: "" }),
    { enabled: false, reason: "missing SENTRY_RELEASE" },
  );
  assert.deepEqual(
    shouldTrackSentryRelease({ env: { SENTRY_AUTH_TOKEN: "t" }, release: "sha" }),
    { enabled: false, reason: "not in CI and tracking not enabled" },
  );
  assert.deepEqual(
    shouldTrackSentryRelease({ env: { SENTRY_AUTH_TOKEN: "t", GITHUB_ACTIONS: "true" }, release: "sha" }),
    { enabled: true },
  );
});

test("maybeTrackSentryRelease runs sentry-cli commands when enabled", () => {
  /** @type {{ cmd: string; args: string[] }[]} */
  const calls = [];
  const run = (cmd, args) => {
    calls.push({ cmd, args });
  };

  const res = maybeTrackSentryRelease({
    repoRoot: "/repo",
    env: { SENTRY_AUTH_TOKEN: "t", GITHUB_ACTIONS: "true", SENTRY_ORG: "org", SENTRY_PROJECTS: "p1,p2" },
    release: "sha123",
    channel: "stable",
    dryRun: false,
    run,
  });

  assert.deepEqual(res, { status: "tracked" });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0]?.args.slice(0, 3), ["releases", "new", "sha123"]);
  assert.ok(calls[0]?.args.includes("--project"));
  assert.deepEqual(calls[1]?.args.slice(0, 4), ["releases", "set-commits", "sha123", "--auto"]);
  assert.deepEqual(calls[2]?.args.slice(0, 3), ["releases", "finalize", "sha123"]);
  assert.deepEqual(calls[3]?.args.slice(0, 4), ["releases", "deploys", "sha123", "new"]);
});

test("maybeTrackSentryRelease skips on dry-run", () => {
  const res = maybeTrackSentryRelease({
    repoRoot: "/repo",
    env: { SENTRY_AUTH_TOKEN: "t", GITHUB_ACTIONS: "true" },
    release: "sha123",
    channel: "stable",
    dryRun: true,
    run: () => {
      throw new Error("should not run");
    },
  });
  assert.deepEqual(res, { status: "skipped", reason: "dry run" });
});
