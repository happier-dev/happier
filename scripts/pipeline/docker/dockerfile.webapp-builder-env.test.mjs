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

test("webapp-builder stage exports public PostHog and Sentry env without upload credentials", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");
  const section = extractStageSection(raw, "FROM deps-alpine-build AS webapp-builder");

  assert.match(section, /\bARG POSTHOG_HOST\b/);
  assert.match(section, /\bARG SENTRY_DSN\b/);
  assert.match(section, /\bARG SENTRY_RELEASE\b/);
  assert.doesNotMatch(section, /\bARG SENTRY_AUTH_TOKEN\b/);
  assert.doesNotMatch(section, /\bARG SENTRY_URL\b/);
  assert.match(section, /\bARG EXPO_PUBLIC_HAPPIER_SERVER_URL\b/);
  assert.match(section, /\bARG EXPO_PUBLIC_HAPPY_SERVER_URL\b/);
  assert.match(section, /\bARG EXPO_PUBLIC_SERVER_URL\b/);

  assert.match(section, /\bENV EXPO_PUBLIC_HAPPIER_SERVER_URL=\$EXPO_PUBLIC_HAPPIER_SERVER_URL\b/);
  assert.match(section, /\bENV EXPO_PUBLIC_HAPPY_SERVER_URL=\$EXPO_PUBLIC_HAPPY_SERVER_URL\b/);
  assert.match(section, /\bENV EXPO_PUBLIC_SERVER_URL=\$EXPO_PUBLIC_SERVER_URL\b/);
  assert.match(section, /\bENV EXPO_PUBLIC_POSTHOG_KEY=\$POSTHOG_API_KEY\b/);
  assert.match(section, /\bENV EXPO_PUBLIC_POSTHOG_HOST=\$POSTHOG_HOST\b/);
  assert.match(section, /\bENV EXPO_PUBLIC_SENTRY_DSN=\$SENTRY_DSN\b/);
  assert.match(section, /\bENV EXPO_PUBLIC_SENTRY_RELEASE=\$SENTRY_RELEASE\b/);
  assert.match(section, /\bENV EXPO_UNSTABLE_WEB_MODAL=1\b/);
  assert.doesNotMatch(section, /\bENV EXPO_PUBLIC_POSTHOG_API_KEY=\$POSTHOG_API_KEY\b/);

  assert.doesNotMatch(section, /\bSENTRY_AUTH_TOKEN\b/);
  assert.doesNotMatch(section, /\bsentry-expo-upload-sourcemaps\b/);
  assert.doesNotMatch(section, /--mount=type=secret/);
  assert.match(section, /precompress-ui-web-assets\.mjs --dir apps\/ui\/dist --gzip-only/);
});

test("webapp nginx stage serves precompressed gzip sidecars", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");
  const section = extractStageSection(raw, "FROM nginxinc/nginx-unprivileged:alpine AS webapp");

  assert.match(section, /\bgzip_static on\b/);
  assert.match(section, /\bgzip_vary on\b/);
});
