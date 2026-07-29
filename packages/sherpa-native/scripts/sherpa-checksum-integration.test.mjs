import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const packageRoot = path.resolve(import.meta.dirname, "..");

test("iOS and Android resolve sherpa checksums through the shared package helper", () => {
  const podspec = readFileSync(path.join(packageRoot, "ios", "HappierSherpaNative.podspec"), "utf8");
  const gradle = readFileSync(path.join(packageRoot, "android", "build.gradle"), "utf8");

  assert.match(podspec, /resolve-sherpa-checksum\.mjs/);
  assert.match(gradle, /resolve-sherpa-checksum\.mjs/);
  assert.match(gradle, /providers\.exec\s*\{/);

  assert.doesNotMatch(podspec, /grep " #\{sherpa_archive\}\$"/);
  assert.doesNotMatch(gradle, /parts\[1\] == sherpaArchive/);
  assert.doesNotMatch(gradle, /parts\[0\] == sherpaArchive/);
  assert.doesNotMatch(gradle, /^\s*exec\s*\{/m);
});
