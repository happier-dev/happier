import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function extractPodspecAssignment(podspec, property) {
  const match = podspec.match(new RegExp(`^\\s*s\\.${property}\\s*=([\\s\\S]*?)(?=^\\s*s\\.|^end\\b)`, "m"));
  assert.ok(match, `expected s.${property} assignment`);
  return match[1];
}

function extractOptionalPodspecAssignment(podspec, property) {
  const match = podspec.match(new RegExp(`^\\s*s\\.${property}\\s*=([\\s\\S]*?)(?=^\\s*s\\.|^end\\b)`, "m"));
  return match?.[1] ?? "";
}

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

test("iOS podspec does not expose vendored C++ headers as module sources", () => {
  const podspec = readFileSync(path.join(packageRoot, "ios", "HappierSherpaNative.podspec"), "utf8");
  const sourceFiles = extractPodspecAssignment(podspec, "source_files");

  assert.doesNotMatch(sourceFiles, /\*\*\//);
  assert.doesNotMatch(sourceFiles, /vendor\//);
});

test("iOS podspec exposes the shared TTS job registry header to the pod target", () => {
  const podspec = readFileSync(path.join(packageRoot, "ios", "HappierSherpaNative.podspec"), "utf8");
  const offlineSource = readFileSync(path.join(packageRoot, "ios", "HappierSherpaOfflineTtsEngine.mm"), "utf8");
  const sourceFiles = extractPodspecAssignment(podspec, "source_files");
  const privateHeaders = extractOptionalPodspecAssignment(podspec, "private_header_files");
  const publicHeaders = extractOptionalPodspecAssignment(podspec, "public_header_files");
  const targetConfig = extractPodspecAssignment(podspec, "pod_target_xcconfig");

  assert.ok(
    sourceFiles.includes("../common/cpp/HappierSherpaTtsJobRegistry.h"),
    "shared TTS registry header must be part of the iOS pod sources",
  );
  assert.ok(
    privateHeaders.includes("../common/cpp/HappierSherpaTtsJobRegistry.h"),
    "shared TTS registry header must be registered as a private CocoaPods header",
  );
  assert.ok(
    !publicHeaders.includes("../common/cpp/HappierSherpaTtsJobRegistry.h"),
    "pure C++ registry header must not be published through the Objective-C module umbrella",
  );
  assert.match(targetConfig, /PODS_TARGET_SRCROOT\)\/\.\.\/common\/cpp/);
  assert.match(offlineSource, /^#import "HappierSherpaTtsJobRegistry\.h"$/m);
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

test("Sherpa VAD is frame-fed inference and does not own microphone capture", () => {
  const types = readFileSync(path.join(packageRoot, "src", "HappierSherpaNative.types.ts"), "utf8");
  const iosModule = readFileSync(path.join(packageRoot, "ios", "HappierSherpaNativeModule.swift"), "utf8");
  const androidModule = readFileSync(
    path.join(packageRoot, "android", "src", "main", "java", "dev", "happier", "sherpa", "HappierSherpaNativeModule.kt"),
    "utf8",
  );

  for (const source of [types, iosModule, androidModule]) {
    assert.match(source, /createVadDetector/);
    assert.match(source, /pushVadAudioFrame/);
    assert.match(source, /cancelVadDetector/);
    assert.doesNotMatch(source, /startVadSession|stopVadSession|vadSpeechEnd/);
  }

  assert.equal(existsSync(path.join(packageRoot, "ios", "AvAudioEngineVadAudioCapture.swift")), false);
  assert.equal(existsSync(path.join(packageRoot, "ios", "IosVadSessionRunner.swift")), false);
  assert.equal(
    existsSync(path.join(packageRoot, "android", "src", "main", "java", "dev", "happier", "sherpa", "vad", "AndroidVadSessionRunner.kt")),
    false,
  );
});
