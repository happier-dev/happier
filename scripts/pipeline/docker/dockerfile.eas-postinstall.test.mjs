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

test("Dockerfile deps stages include the root postinstall script (eas-postinstall.mjs) so yarn install can run in minimal build contexts", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");

  for (const marker of [
    "FROM node:${NODE_VERSION}-alpine AS deps-alpine",
    "FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS deps-alpine-build",
    "FROM node:${NODE_VERSION} AS deps-debian",
  ]) {
    const section = extractStageSection(raw, marker);
    assert.match(section, /COPY scripts\/pipeline\/expo\/eas-postinstall\.mjs scripts\/pipeline\/expo\//);
  }
});

test("dev-box Dockerfile includes the root postinstall script (eas-postinstall.mjs) so yarn install can run in minimal build contexts", () => {
  const dockerfilePath = path.join(repoRoot, "docker", "dev-box", "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");
  const section = extractStageSection(raw, "FROM node:${NODE_VERSION}-bookworm AS cli-builder");
  assert.match(section, /COPY scripts\/pipeline\/expo\/eas-postinstall\.mjs scripts\/pipeline\/expo\//);
});
