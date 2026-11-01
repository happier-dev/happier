import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The Android release archive ships only prebuilt .so files, so the JNI layer compiles against a vendored
// copy of upstream sherpa-onnx/c-api/c-api.h. The copy must be byte-identical to the header of the pinned
// runtime: struct layouts cross the ABI boundary by value, and a drifted layout corrupts the config silently.
// Bumping the runtime version requires replacing the header with the new upstream file and its sha256 here.
const UPSTREAM_C_API_HEADER_SHA256 = {
  "v1.12.25": "3146584555a3ac32aa5d9b138a5fb0acca6a923bd246f0ebcf2d274df6bf0c63",
};

function pinnedVersion(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `expected a pinned sherpa-onnx version in ${label}`);
  return match[1];
}

test("Android vendored sherpa-onnx C API header is the verbatim upstream header of the pinned runtime", () => {
  const gradle = readFileSync(path.join(packageRoot, "android", "build.gradle"), "utf8");
  const version = pinnedVersion(gradle, /HAPPIER_SHERPA_ONNX_VERSION"\)\s*\?:\s*"(v[\d.]+)"/, "android/build.gradle");
  const expected = UPSTREAM_C_API_HEADER_SHA256[version];
  assert.ok(expected, `no upstream c-api.h checksum recorded for ${version}; vendor the upstream header and pin it`);

  const header = readFileSync(
    path.join(packageRoot, "android", "src", "main", "cpp", "include", "sherpa-onnx", "c-api", "c-api.h"),
  );
  assert.equal(createHash("sha256").update(header).digest("hex"), expected);
});

test("iOS and Android pin the same sherpa-onnx runtime version", () => {
  const gradle = readFileSync(path.join(packageRoot, "android", "build.gradle"), "utf8");
  const podspec = readFileSync(path.join(packageRoot, "ios", "HappierSherpaNative.podspec"), "utf8");
  assert.equal(
    pinnedVersion(podspec, /HAPPIER_SHERPA_ONNX_VERSION'\]\s*\|\|\s*'(v[\d.]+)'/, "ios/HappierSherpaNative.podspec"),
    pinnedVersion(gradle, /HAPPIER_SHERPA_ONNX_VERSION"\)\s*\?:\s*"(v[\d.]+)"/, "android/build.gradle"),
  );
});
