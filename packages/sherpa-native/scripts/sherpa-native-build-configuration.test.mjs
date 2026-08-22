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

test("iOS podspec exposes the shared native registry headers to the pod target", () => {
  const podspec = readFileSync(path.join(packageRoot, "ios", "HappierSherpaNative.podspec"), "utf8");
  const offlineSource = readFileSync(path.join(packageRoot, "ios", "HappierSherpaOfflineTtsEngine.mm"), "utf8");
  const onlineSource = readFileSync(path.join(packageRoot, "ios", "HappierSherpaOnlineAsrEngine.mm"), "utf8");
  const sourceFiles = extractPodspecAssignment(podspec, "source_files");
  const privateHeaders = extractOptionalPodspecAssignment(podspec, "private_header_files");
  const publicHeaders = extractOptionalPodspecAssignment(podspec, "public_header_files");
  const targetConfig = extractPodspecAssignment(podspec, "pod_target_xcconfig");

  for (const header of ["HappierSherpaTtsJobRegistry.h", "HappierSherpaAsrStreamRegistry.h"]) {
    assert.ok(
      sourceFiles.includes(`../common/cpp/${header}`),
      `shared registry header ${header} must be part of the iOS pod sources`,
    );
    assert.ok(
      privateHeaders.includes(`../common/cpp/${header}`),
      `shared registry header ${header} must be registered as a private CocoaPods header`,
    );
    assert.ok(
      !publicHeaders.includes(`../common/cpp/${header}`),
      `pure C++ registry header ${header} must not be published through the Objective-C module umbrella`,
    );
  }
  assert.match(targetConfig, /PODS_TARGET_SRCROOT\)\/\.\.\/common\/cpp/);
  assert.match(offlineSource, /^#import "HappierSherpaTtsJobRegistry\.h"$/m);
  assert.match(onlineSource, /^#import "HappierSherpaAsrStreamRegistry\.h"$/m);
});

test("streaming ASR ownership lives in the shared registry, not beside it", () => {
  const onlineSource = readFileSync(path.join(packageRoot, "ios", "HappierSherpaOnlineAsrEngine.mm"), "utf8");
  const moduleSource = readFileSync(path.join(packageRoot, "ios", "HappierSherpaNativeModule.swift"), "utf8");
  const jniSource = readFileSync(
    path.join(packageRoot, "android", "src", "main", "cpp", "HappierSherpaNativeJni.cpp"),
    "utf8",
  );

  // Both platforms instantiate the one owner, differing only in the handle
  // const-qualification their vendored sherpa header uses.
  assert.match(
    jniSource,
    /happier_sherpa::AsrStreamRegistry<const SherpaOnnxOnlineRecognizer, SherpaOnnxOnlineStream>/,
    "Android streaming ASR must be owned by the shared registry",
  );
  assert.match(
    onlineSource,
    /happier_sherpa::AsrStreamRegistry<const SherpaOnnxOnlineRecognizer, const SherpaOnnxOnlineStream>/,
    "iOS streaming ASR must be owned by the shared registry",
  );

  // A decode must never hold a handle the registry can free underneath it.
  for (const source of [jniSource, onlineSource]) {
    assert.doesNotMatch(
      source,
      /SherpaOnnxDestroyOnlineStream\((?!\))(?!.*shared_ptr)[^)]*\)\s*;/,
      "streams must be destroyed by their shared_ptr deleter, never by an explicit call",
    );
    assert.match(
      source,
      /while \(!job->cancelled\(\) && SherpaOnnxIsOnlineStreamReady\(/,
      "the decode loop must observe the job's cancel mark between iterations",
    );
  }

  // The Swift module must not keep a second ASR lifetime owner beside the registry.
  assert.doesNotMatch(moduleSource, /asrStreams|asrEngines/);
});

test("iOS Swift module uses Objective-C failable and throwing imports", () => {
  const moduleSource = readFileSync(path.join(packageRoot, "ios", "HappierSherpaNativeModule.swift"), "utf8");
  const offlineHeader = readFileSync(path.join(packageRoot, "ios", "HappierSherpaOfflineTtsEngine.h"), "utf8");
  const onlineHeader = readFileSync(path.join(packageRoot, "ios", "HappierSherpaOnlineAsrEngine.h"), "utf8");

  assert.match(offlineHeader, /-\s*\(nullable instancetype\)initWithAssetsDir:/);
  assert.match(moduleSource, /try HappierSherpaOfflineTtsEngine\(assetsDir: assetsDir\)/);
  assert.match(moduleSource, /try engine\.synthesizeToWavFile\(atPath: outWavPath, text: text, sid: Int32\(sid\), speed: Float\(speed\), jobId: jobId\)/);
  assert.doesNotMatch(moduleSource, /engine\.synthesizeToWavFile\(.*error: &err/);

  // Streaming ASR is addressed by job id on the class, so these selectors are the
  // whole iOS bridge; the Swift spellings below are what the Clang importer
  // produces for them.
  assert.match(onlineHeader, /\+\s*\(BOOL\)createStreamForJob:\(NSString \*\)jobId/);
  assert.match(onlineHeader, /\+\s*\(NSDictionary \*\)pushPcm16Data:\(NSData \*\)pcm16le/);
  assert.match(onlineHeader, /\+\s*\(NSString \*\)finishJob:\(NSString \*\)jobId;/);
  assert.match(onlineHeader, /\+\s*\(void\)cancelJob:\(NSString \*\)jobId;/);
  assert.match(onlineHeader, /\+\s*\(NSUInteger\)releaseAssetsDir:\(NSString \*\)assetsDir;/);
  assert.match(onlineHeader, /\+\s*\(NSUInteger\)releaseAll;/);

  assert.match(moduleSource, /try HappierSherpaOnlineAsrEngine\.createStream\(forJob: jobId, assetsDir: assetsDir\)/);
  assert.match(moduleSource, /HappierSherpaOnlineAsrEngine\.pushPcm16Data\(data, forJob: jobId, sampleRate: Int32\(sampleRate\), channels: Int32\(channels\), error: &err\)/);
  assert.match(moduleSource, /HappierSherpaOnlineAsrEngine\.finishJob\(jobId\)/);
  assert.match(moduleSource, /HappierSherpaOnlineAsrEngine\.cancelJob\(jobId\)/);
  assert.match(moduleSource, /HappierSherpaOnlineAsrEngine\.releaseAssetsDir\(assetsDir\)/);
  assert.match(moduleSource, /HappierSherpaOnlineAsrEngine\.releaseAll\(\)/);
  assert.match(moduleSource, /if let err \{ throw err \}/);
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
