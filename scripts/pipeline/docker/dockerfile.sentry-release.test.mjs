import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

function extractStageSection(dockerfile, stageMarker) {
  const start = dockerfile.indexOf(stageMarker);
  assert.ok(start >= 0, `missing stage marker: ${stageMarker}`);
  const after = dockerfile.slice(start);
  const nextFromIndex = after.indexOf("\nFROM ");
  return nextFromIndex >= 0 ? after.slice(0, nextFromIndex) : after;
}

test("relay-server stage bakes SENTRY_RELEASE into runtime env", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");
  const section = extractStageSection(raw, "FROM server AS relay-server");

  assert.match(section, /\bARG SENTRY_RELEASE\b/);
  assert.match(section, /\bENV SENTRY_RELEASE=\$SENTRY_RELEASE\b/);
  assert.match(section, /\bARG SENTRY_SERVER_CENTRAL_DSN\b/);
  assert.match(section, /\bENV HAPPIER_SENTRY_CENTRAL_DSN=\$SENTRY_SERVER_CENTRAL_DSN\b/);
  assert.match(section, /\bENV HAPPIER_SENTRY_USE_CENTRAL_DSN=1\b/);
});
