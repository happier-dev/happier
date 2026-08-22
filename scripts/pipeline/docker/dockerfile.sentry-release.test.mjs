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
  const section = extractStageSection(raw, "FROM debian:12-slim AS relay-server");

  assert.match(section, /\bARG SENTRY_RELEASE\b/);
  assert.match(section, /\bENV SENTRY_RELEASE=\$SENTRY_RELEASE\b/);
  assert.match(section, /\bENV HAPPIER_RELEASE_SOURCE_SHA=\$SENTRY_RELEASE\b/);
  assert.match(section, /\bARG SENTRY_SERVER_CENTRAL_DSN\b/);
  assert.match(section, /\bENV HAPPIER_SENTRY_CENTRAL_DSN=\$SENTRY_SERVER_CENTRAL_DSN\b/);
  assert.match(section, /\bENV HAPPIER_SENTRY_USE_CENTRAL_DSN=1\b/);
});

test("hosted server stage exposes the exact build source revision", () => {
  const raw = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const section = extractStageSection(raw, "FROM node:${NODE_VERSION} AS server");

  assert.match(section, /\bARG SENTRY_RELEASE\b/);
  assert.match(section, /\bENV HAPPIER_RELEASE_SOURCE_SHA=\$SENTRY_RELEASE\b/);
});

test("relay-server target is artifact based and keeps the self-host runtime contract", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");
  const artifactSection = extractStageSection(raw, "FROM debian:12-slim AS relay-artifacts");
  const runtimeSection = extractStageSection(raw, "FROM debian:12-slim AS relay-server");

  assert.match(artifactSection, /fetch-verified-release-artifact/);
  assert.match(artifactSection, /HAPPIER_RELAY_SERVER_RELEASE_TAG/);
  assert.match(artifactSection, /HAPPIER_RELAY_SERVER_VERSION/);
  assert.doesNotMatch(artifactSection, /HAPPIER_RELAY_UI_WEB_RELEASE_TAG/);
  assert.doesNotMatch(artifactSection, /HAPPIER_RELAY_UI_WEB_VERSION/);
  assert.match(artifactSection, /happier-server/);
  assert.doesNotMatch(artifactSection, /happier-ui-web/);
  assert.doesNotMatch(artifactSection, /rm -rf \/opt\/happier\/server\/ui-web/);
  assert.match(artifactSection, /rm -rf \/opt\/happier\/server\/generated\/mysql-client/);
  assert.match(artifactSection, /libquery_engine-debian-openssl-3\.0\.x\.so\.node/);
  assert.match(artifactSection, /libquery_engine-linux-arm64-openssl-3\.0\.x\.so\.node/);
  assert.match(artifactSection, /sharp-libvips-linuxmusl-x64/);
  assert.match(artifactSection, /sharp-linuxmusl-x64/);
  assert.match(artifactSection, /sharp-libvips-linuxmusl-arm64/);
  assert.match(artifactSection, /sharp-linuxmusl-arm64/);

  assert.doesNotMatch(raw, /^FROM\s+server\s+AS\s+relay-server\s*$/m);
  assert.match(runtimeSection, /COPY --from=relay-artifacts --chown=happier:happier \/opt\/happier\/server \/opt\/happier\/server/);
  assert.doesNotMatch(runtimeSection, /COPY --from=relay-artifacts --chown=happier:happier \/opt\/happier\/ui-web \/opt\/happier\/ui-web/);
  assert.match(runtimeSection, /useradd -m -s \/bin\/bash happier/);
  assert.match(runtimeSection, /mkdir -p \/data \/opt\/happier\/server/);
  assert.match(runtimeSection, /chown -R happier:happier \/data \/opt\/happier/);
  assert.match(runtimeSection, /\bENV NODE_ENV=production\b/);
  assert.match(runtimeSection, /\bENV PORT=3005\b/);
  assert.match(runtimeSection, /\bENV HAPPIER_SERVER_FLAVOR=light\b/);
  assert.match(runtimeSection, /\bENV HAPPIER_DB_PROVIDER=sqlite\b/);
  assert.match(runtimeSection, /\bENV HAPPIER_SERVER_LIGHT_DATA_DIR=\/data\b/);
  assert.match(runtimeSection, /\bENV HAPPIER_SERVER_UI_DIR=\/opt\/happier\/server\/ui-web\/current\b/);
  assert.match(runtimeSection, /\bENV HAPPIER_SERVER_UI_REQUIRED=1\b/);
  assert.match(runtimeSection, /\bENV HAPPIER_SQLITE_AUTO_MIGRATE=1\b/);
  assert.match(runtimeSection, /\bENV HAPPIER_SQLITE_MIGRATIONS_DIR=\/opt\/happier\/server\/prisma\/sqlite\/migrations\b/);
  assert.match(runtimeSection, /\bENV HAPPY_SQLITE_MIGRATIONS_DIR=\/opt\/happier\/server\/prisma\/sqlite\/migrations\b/);
  assert.match(runtimeSection, /\bUSER happier\b/);
  assert.match(runtimeSection, /VOLUME \["\/data"\]/);
  assert.match(runtimeSection, /CMD \["\/opt\/happier\/server\/happier-server"\]/);
});
