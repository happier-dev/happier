import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function extractPodspecAssignment(podspec, property) {
  const match = podspec.match(new RegExp(`^\\s*s\\.${property}\\s*=([\\s\\S]*?)(?=^\\s*s\\.|^end\\b)`, "m"));
  assert.ok(match, `expected s.${property} assignment`);
  return match[1];
}

test("Android JNI library requests 16 KB LOAD and RELRO page alignment", () => {
  const cmake = readFileSync(path.join(packageRoot, "android", "src", "main", "cpp", "CMakeLists.txt"), "utf8");
  const linkOptions = cmake.match(/target_link_options\(happier_sherpa_jni\s+PRIVATE([\s\S]*?)\)/);

  assert.ok(linkOptions, "sherpa JNI target must configure Android linker page alignment");
  assert.match(linkOptions[1], /"-Wl,-z,max-page-size=16384"/);
  assert.match(linkOptions[1], /"-Wl,-z,common-page-size=16384"/);
});

test("Android JNI source includes the standard containers it instantiates", () => {
  const jniSource = readFileSync(
    path.join(packageRoot, "android", "src", "main", "cpp", "HappierSherpaNativeJni.cpp"),
    "utf8",
  );

  assert.match(jniSource, /^#include <vector>$/m);
});

test("iOS Objective-C++ sources include the standard library headers they instantiate", () => {
  const offlineSource = readFileSync(path.join(packageRoot, "ios", "HappierSherpaOfflineTtsEngine.mm"), "utf8");
  const onlineSource = readFileSync(path.join(packageRoot, "ios", "HappierSherpaOnlineAsrEngine.mm"), "utf8");

  assert.match(offlineSource, /^#include <cstring>$/m);
  assert.match(offlineSource, /^#include <memory>$/m);
  assert.match(onlineSource, /^#include <cstring>$/m);
});

test("iOS online ASR wrapper matches the vendored sherpa-onnx C API shape", () => {
  const onlineSource = readFileSync(path.join(packageRoot, "ios", "HappierSherpaOnlineAsrEngine.mm"), "utf8");

  assert.doesNotMatch(onlineSource, /config\.decoder_config/);
  assert.doesNotMatch(onlineSource, /config\.endpoint_config/);
  assert.match(onlineSource, /config\.decoding_method = "greedy_search";/);
  assert.match(onlineSource, /config\.max_active_paths = 4;/);
  assert.match(onlineSource, /config\.enable_endpoint = 1;/);
  assert.match(onlineSource, /config\.rule1_min_trailing_silence = 1\.2f;/);
  assert.match(onlineSource, /config\.rule2_min_trailing_silence = 0\.6f;/);
  assert.match(onlineSource, /config\.rule3_min_utterance_length = 15\.0f;/);
  assert.match(onlineSource, /const SherpaOnnxOnlineStream \*_stream;/);
  assert.match(onlineSource, /initWithRecognizer:_recognizer stream:stream/);
  assert.doesNotMatch(onlineSource, /wrapper->_/);
});

test("iOS podspec does not expose vendored C++ headers as module sources", () => {
  const podspec = readFileSync(path.join(packageRoot, "ios", "HappierSherpaNative.podspec"), "utf8");
  const sourceFiles = extractPodspecAssignment(podspec, "source_files");

  assert.doesNotMatch(sourceFiles, /\*\*\//);
  assert.doesNotMatch(sourceFiles, /vendor\//);
});

test("iOS Swift module uses Objective-C failable and throwing imports", () => {
  const moduleSource = readFileSync(path.join(packageRoot, "ios", "HappierSherpaNativeModule.swift"), "utf8");
  const offlineHeader = readFileSync(path.join(packageRoot, "ios", "HappierSherpaOfflineTtsEngine.h"), "utf8");
  const onlineHeader = readFileSync(path.join(packageRoot, "ios", "HappierSherpaOnlineAsrEngine.h"), "utf8");

  assert.match(offlineHeader, /-\s*\(nullable instancetype\)initWithAssetsDir:/);
  assert.match(onlineHeader, /-\s*\(nullable instancetype\)initWithAssetsDir:/);
  assert.match(moduleSource, /try HappierSherpaOfflineTtsEngine\(assetsDir: assetsDir\)/);
  assert.match(moduleSource, /try HappierSherpaOnlineAsrEngine\(assetsDir: assetsDir, sampleRate: 16000, language: langKey\.isEmpty \? nil : langKey\)/);
  assert.match(moduleSource, /try engine\.synthesizeToWavFile\(atPath: outWavPath, text: text, sid: Int32\(sid\), speed: Float\(speed\), jobId: jobId\)/);
  assert.match(moduleSource, /let stream = try engine\.createStream\(\)/);
  assert.match(moduleSource, /let result = stream\.pushPcm16Data\(data, sampleRate: Int32\(sampleRate\), channels: Int32\(channels\), error: &err\)/);
  assert.match(moduleSource, /if let err \{ throw err \}/);
  assert.match(moduleSource, /let text = stream\.finishWithError\(&err\)/);
  assert.doesNotMatch(moduleSource, /engine\.synthesizeToWavFile\(.*error: &err/);
  assert.doesNotMatch(moduleSource, /createStreamWithError/);
});
