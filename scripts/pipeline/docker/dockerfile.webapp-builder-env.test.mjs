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

test("webapp-builder stage exports PostHog + Sentry public env and supports optional sourcemaps upload", () => {
  const dockerfilePath = path.join(repoRoot, "Dockerfile");
  const raw = fs.readFileSync(dockerfilePath, "utf8");
  const section = extractStageSection(raw, "FROM deps-alpine-build AS webapp-builder");

  assert.match(section, /\bARG POSTHOG_HOST\b/);
  assert.match(section, /\bARG SENTRY_DSN\b/);
  assert.match(section, /\bARG SENTRY_RELEASE\b/);
  assert.match(section, /\bARG SENTRY_AUTH_TOKEN\b/);
  assert.match(section, /\bARG SENTRY_URL\b/);
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
  assert.doesNotMatch(section, /\bENV EXPO_PUBLIC_POSTHOG_API_KEY=\$POSTHOG_API_KEY\b/);

  assert.match(section, /\bRUN if \[ -n "\$SENTRY_AUTH_TOKEN" \]; then\b/);
  assert.match(section, /\bsentry-expo-upload-sourcemaps dist\b/);
});
