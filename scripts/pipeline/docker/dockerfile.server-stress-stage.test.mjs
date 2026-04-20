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

test("server-stress stage avoids recursive repo ownership rewrites", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");
  const section = extractStageSection(raw, "FROM server-builder AS server-stress");

  assert.match(section, /RUN mkdir -p \/data\b/);
  assert.doesNotMatch(section, /chown -R node:node \/data \/repo/);
  assert.match(section, /USER node/);
  assert.match(section, /CMD \["\/repo\/apps\/server\/scripts\/run-server\.sh"\]/);
});
