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
    assert.match(section, /COPY scripts\/ci\/yarn-install-with-retry\.sh \/usr\/local\/bin\/yarn-install-with-retry/);
  }
});

test("Dockerfile deps stages copy shared workspace build tooling for derived workspace postinstall builds", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");

  for (const marker of [
    "FROM node:${NODE_VERSION}-alpine AS deps-alpine",
    "FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS deps-alpine-build",
    "FROM node:${NODE_VERSION} AS deps-debian",
  ]) {
    const section = extractStageSection(raw, marker);
    const installIndex = section.indexOf("yarn-install-with-retry --frozen-lockfile");
    const copyIndex = section.indexOf("COPY scripts/workspaces ./scripts/workspaces");

    assert.ok(installIndex >= 0, `${marker} must install dependencies`);
    assert.ok(copyIndex >= 0, `${marker} must copy scripts/workspaces`);
    assert.ok(
      installIndex < copyIndex,
      `${marker} must copy scripts/workspaces after dependency install so helper edits do not invalidate the install cache`,
    );
  }
});

test("dev-box Dockerfile no longer runs a source yarn install", () => {
  const dockerfilePath = path.join(repoRoot, "docker", "dev-box", "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");

  assert.doesNotMatch(raw, /AS cli-builder/);
  assert.doesNotMatch(raw, /yarn-install-with-retry --frozen-lockfile/);
  assert.doesNotMatch(raw, /COPY scripts\/pipeline\/expo\/eas-postinstall\.mjs scripts\/pipeline\/expo\//);
});
