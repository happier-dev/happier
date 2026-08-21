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

test("Dockerfile deps stages copy the shared yarn-install-with-retry helper from scripts/ci", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");

  for (const marker of [
    "FROM node:${NODE_VERSION}-alpine AS deps-alpine",
    "FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS deps-alpine-build",
    "FROM node:${NODE_VERSION} AS deps-debian",
  ]) {
    const section = extractStageSection(raw, marker);
    assert.match(section, /COPY scripts\/ci\/yarn-install-with-retry\.sh \/usr\/local\/bin\/yarn-install-with-retry/);
    assert.doesNotMatch(section, /COPY docker\/scripts\/yarn-install-with-retry\.sh \/usr\/local\/bin\/yarn-install-with-retry/);
  }
});

test("Dockerfile deps stages include the UI postinstall runner before yarn install", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");

  for (const marker of [
    "FROM node:${NODE_VERSION}-alpine AS deps-alpine",
    "FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS deps-alpine-build",
    "FROM node:${NODE_VERSION} AS deps-debian",
  ]) {
    const section = extractStageSection(raw, marker);
    const installIndex = section.indexOf("yarn-install-with-retry --frozen-lockfile");
    const copyIndex = section.indexOf("COPY apps/ui/tools/postinstall ./apps/ui/tools/postinstall");

    assert.ok(installIndex >= 0, `${marker} must install dependencies`);
    assert.ok(copyIndex >= 0, `${marker} must copy the UI postinstall runner`);
    assert.ok(
      copyIndex < installIndex,
      `${marker} must copy the UI postinstall runner before dependency install`,
    );
  }
});

test("Dockerfile builds the source privacy-kit workspace required by the server", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");

  for (const marker of [
    "FROM node:${NODE_VERSION}-alpine AS deps-alpine",
    "FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS deps-alpine-build",
    "FROM node:${NODE_VERSION} AS deps-debian",
  ]) {
    const section = extractStageSection(raw, marker);
    assert.match(section, /COPY packages\/privacy-kit\/package\.json packages\/privacy-kit\//);
  }

  const serverBuilder = extractStageSection(raw, "FROM deps-debian AS server-builder");
  const privacyBuildIndex = serverBuilder.indexOf("yarn workspace privacy-kit build");
  const serverBuildIndex = serverBuilder.indexOf("yarn workspace @happier-dev/server build");
  assert.match(serverBuilder, /COPY packages\/privacy-kit \.\/packages\/privacy-kit/);
  assert.ok(privacyBuildIndex >= 0, "server builder must build privacy-kit from the checkout");
  assert.ok(serverBuildIndex >= 0, "server builder must build the server");
  assert.ok(privacyBuildIndex < serverBuildIndex, "privacy-kit must be built before the server");

  const server = extractStageSection(raw, "FROM node:${NODE_VERSION} AS server");
  assert.match(
    server,
    /COPY --from=server-builder --chown=node:node \/repo\/packages\/privacy-kit \/repo\/packages\/privacy-kit/,
  );
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
    const stackUtilsCopyIndex = section.indexOf(
      "COPY apps/stack/scripts/utils ./apps/stack/scripts/utils",
    );
    const workspaceLockCopyIndex = section.indexOf(
      "COPY packages/cli-common/workspaceBundleLock.mjs packages/cli-common/workspaceLockLease.mjs packages/cli-common/processInstance.mjs ./packages/cli-common/",
    );

    assert.ok(installIndex >= 0, `${marker} must install dependencies`);
    assert.ok(copyIndex >= 0, `${marker} must copy scripts/workspaces`);
    assert.ok(stackUtilsCopyIndex >= 0, `${marker} must copy the workspace build utility dependency closure`);
    assert.ok(workspaceLockCopyIndex >= 0, `${marker} must copy the workspace lock dependency closure`);
    assert.ok(
      installIndex < copyIndex,
      `${marker} must copy scripts/workspaces after dependency install so helper edits do not invalidate the install cache`,
    );
    assert.ok(
      installIndex < stackUtilsCopyIndex,
      `${marker} must copy the workspace build utility dependency closure after dependency install`,
    );
    assert.ok(
      installIndex < workspaceLockCopyIndex,
      `${marker} must copy the workspace lock dependency closure after dependency install`,
    );
  }
});

test("dev-box Dockerfile no longer runs a source yarn install", () => {
  const dockerfilePath = path.join(repoRoot, "docker", "dev-box", "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");
  assert.doesNotMatch(raw, /yarn-install-with-retry/);
  assert.doesNotMatch(raw, /COPY scripts\/pipeline\/expo\/eas-postinstall\.mjs scripts\/pipeline\/expo\//);
});
