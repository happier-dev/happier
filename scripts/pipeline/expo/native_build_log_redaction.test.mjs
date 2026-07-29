import assert from "node:assert/strict";
import test from "node:test";

import {
  createNativeBuildLogRedactor,
  formatNativeBuildCommand,
  redactNativeBuildLogText,
} from "./native-build-log-redaction.mjs";

const payload =
  "eyJqb2IiOnsic2VjcmV0cyI6eyJidWlsZENyZWRlbnRpYWxzIjp7ImlvcyI6eyJwcm92aXNpb25pbmdQcm9maWxlIjoiYmFzZTY0LXNlY3JldC1wYXlsb2FkIn19fX19";
const payloadWithSecretsOnly = Buffer.from(
  JSON.stringify({ job: { secrets: { token: "secret-token" } }, metadata: { platform: "ios" } }),
).toString("base64");

test("redacts EAS local build plugin payloads from child process output", () => {
  const line = `npx -y eas-cli-local-build-plugin@18.0.1 ${payload} exited with non-zero code: 1`;

  const redacted = redactNativeBuildLogText(line);

  assert.equal(
    redacted,
    "npx -y eas-cli-local-build-plugin@18.0.1 <redacted-eas-local-build-payload> exited with non-zero code: 1",
  );
  assert.doesNotMatch(redacted, /buildCredentials|YmFzZTY0|eyJqb2Ii/);
});

test("redacts markerless EAS local build payloads emitted by local plugin path overrides", () => {
  const line = `/tmp/eas-local-build-plugin ${payload} exited with non-zero code: 1`;

  const redacted = redactNativeBuildLogText(line);

  assert.equal(
    redacted,
    "/tmp/eas-local-build-plugin <redacted-eas-local-build-payload> exited with non-zero code: 1",
  );
  assert.doesNotMatch(redacted, /buildCredentials|YmFzZTY0|eyJqb2Ii/);
});

test("redacts markerless EAS local build payloads that contain job secrets without build credentials", () => {
  const line = `/tmp/eas-local-build-plugin ${payloadWithSecretsOnly} failed`;

  const redacted = redactNativeBuildLogText(line);

  assert.equal(redacted, "/tmp/eas-local-build-plugin <redacted-eas-local-build-payload> failed");
  assert.doesNotMatch(redacted, /secret-token|eyJqb2Ii/);
});

test("redacts EAS local build plugin payloads from printable commands", () => {
  const printable = formatNativeBuildCommand("npx", [
    "-y",
    "eas-cli-local-build-plugin@18.0.1",
    payload,
  ]);

  assert.equal(printable, "npx -y eas-cli-local-build-plugin@18.0.1 <redacted-eas-local-build-payload>");
});

test("redacts EAS local build plugin payloads split across output chunks", () => {
  const redactor = createNativeBuildLogRedactor();

  assert.equal(redactor.push("npx -y eas-cli-local-build-plugin@18.0.1 "), "");

  const redacted = redactor.push(`${payload} exited with non-zero code: 1\n`);
  assert.equal(
    redacted,
    "npx -y eas-cli-local-build-plugin@18.0.1 <redacted-eas-local-build-payload> exited with non-zero code: 1\n",
  );
  assert.equal(redactor.flush(), "");
});

test("preserves non-sensitive commands", () => {
  assert.equal(
    formatNativeBuildCommand("eas", ["build", "--platform", "ios", "--local"]),
    "eas build --platform ios --local",
  );
});
