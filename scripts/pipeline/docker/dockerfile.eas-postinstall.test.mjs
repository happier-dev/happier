import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { resolveYarnCommandInvocation } from "../../workspaces/execYarnCommand.mjs";

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

test("Dockerfile installs UI postinstall assets only in web dependency stages", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");

  for (const marker of [
    "FROM node:${NODE_VERSION}-alpine AS deps-alpine",
    "FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS deps-alpine-build",
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

  const serverDeps = extractStageSection(raw, "FROM node:${NODE_VERSION} AS deps-debian");
  const workspaceManifests = Array.from(
    serverDeps.matchAll(/^\s*COPY ((?:apps|packages)\/[^ ]+\/package\.json) /gm),
    (match) => match[1],
  ).sort();
  assert.deepEqual(workspaceManifests, [
    "apps/server/package.json",
    "packages/agents/package.json",
    "packages/cli-common/package.json",
    "packages/privacy-kit/package.json",
    "packages/protocol/package.json",
    "packages/release-runtime/package.json",
  ]);
  assert.doesNotMatch(serverDeps, /COPY apps\/ui\/tools\/postinstall /);
});

test("Dockerfile builds the source workspaces required by server generation", () => {
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
  const releaseRuntimeBuildIndex = serverBuilder.indexOf("yarn workspace @happier-dev/release-runtime postinstall:real");
  const cliCommonBuildIndex = serverBuilder.indexOf("yarn workspace @happier-dev/cli-common postinstall:real");
  const serverGenerationIndex = serverBuilder.indexOf("yarn workspace @happier-dev/server postinstall:real");
  assert.ok(cliCommonBuildIndex >= 0, "server client generation requires built cli-common exports");
  assert.ok(releaseRuntimeBuildIndex < cliCommonBuildIndex, "cli-common requires built release-runtime exports");
  assert.ok(cliCommonBuildIndex < serverGenerationIndex, "cli-common must be built before server client generation");

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

test("server image production install removes developer Redis tools while retaining built native runtime dependencies", () => {
  const raw = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const builder = extractStageSection(raw, "FROM deps-debian AS server-builder");
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps/server/package.json"), "utf8"));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "happier-server-production-"));
  const putPackage = (relativePath, pkg) => {
    const directory = path.join(fixture, relativePath);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(pkg));
  };
  const install = (args) => {
    const invocation = resolveYarnCommandInvocation(["install", ...args]);
    const result = spawnSync(invocation.command, invocation.args, {
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      cwd: fixture, encoding: "utf8", env: { ...process.env, NODE_ENV: "development", YARN_ENABLE_SCRIPTS: "false" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  try {
    putPackage("", { private: true, workspaces: ["apps/*", "packages/*"], devDependencies: { compiler: "file:fixtures/compiler" } });
    const server = { name: "server", version: "1.0.0", dependencies: { runtime: "file:../../fixtures/runtime", sharp: "file:../../fixtures/sharp", shared: "1.0.0" } };
    for (const kind of ["dependencies", "optionalDependencies", "devDependencies"]) {
      if (manifest[kind]?.["redis-memory-server"]) server[kind] = { ...server[kind], "redis-memory-server": "file:../../fixtures/redis" };
    }
    putPackage("apps/server", server);
    putPackage("packages/shared", { name: "shared", version: "1.0.0", dependencies: { retained: "file:../../fixtures/retained" } });
    for (const name of ["runtime", "retained", "compiler", "extract-zip"]) putPackage(`fixtures/${name}`, { name, version: "1.0.0" });
    putPackage("fixtures/redis", { name: "redis-memory-server", version: "1.0.0", dependencies: { "extract-zip": "file:../extract-zip" } });
    putPackage("fixtures/sharp", { name: "sharp", version: "1.0.0", optionalDependencies: { "@img/sharp-linux-x64": "file:../native" }, scripts: { postinstall: "exit 99" } });
    putPackage("fixtures/native", { name: "@img/sharp-linux-x64", version: "1.0.0" });
    fs.writeFileSync(path.join(fixture, "fixtures/native/addon.node"), "built-runtime-output");
    install(["--ignore-scripts", "--ignore-engines", "--offline"]);
    assert.ok(fs.existsSync(path.join(fixture, "node_modules/redis-memory-server")), "developer install retains automatic Redis validation");
    assert.ok(fs.existsSync(path.join(fixture, "node_modules/extract-zip")));
    const generatedClient = path.join(fixture, "node_modules/.prisma/client/index.js");
    const generatedEngine = path.join(fixture, "node_modules/.prisma/client/query-engine.node");
    const nativeAddon = path.join(fixture, "node_modules/@img/sharp-linux-x64/addon.node");
    for (const filename of [generatedClient, generatedEngine]) {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, "built-runtime-output");
    }
    const productionInstall = builder.match(/yarn-install-with-retry ([^\n]*--production=true[^\n]*)/);
    if (productionInstall) install([...productionInstall[1].trim().split(/\s+/), "--offline"]);
    for (const name of ["redis-memory-server", "extract-zip", "compiler"]) {
      assert.equal(fs.existsSync(path.join(fixture, "node_modules", name)), false, `production image excludes ${name}`);
    }
    for (const name of ["runtime", "shared", "retained", "sharp", "@img/sharp-linux-x64"]) {
      assert.ok(fs.existsSync(path.join(fixture, "node_modules", name)), `production image retains ${name}`);
    }
    for (const filename of [generatedClient, generatedEngine, nativeAddon]) assert.equal(fs.readFileSync(filename, "utf8"), "built-runtime-output");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
