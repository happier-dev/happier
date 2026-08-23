/**
 * Cancellation must be able to preempt native work.
 *
 * Expo dispatches every `AsyncFunction` on ONE SERIAL queue per platform unless
 * the function opts out:
 *
 *   iOS      `expo-modules-core/ios/Core/Functions/AsyncFunctionDefinition.swift`
 *            `private let defaultQueue = DispatchQueue(label: "expo.modules.AsyncFunctionQueue", ...)`
 *            -- a `DispatchQueue` created without `attributes: .concurrent` is serial.
 *   Android  `expo-modules-core/android/.../AppContext.kt`
 *            `HandlerThread("expo.modules.AsyncFunctionQueue")` -> one looper
 *            thread -> `modulesQueue`, on which `AsyncFunctionComponent`
 *            dispatches every `Queues.DEFAULT` function.
 *
 * Sherpa's synthesis and decode calls are synchronous and multi-second, so a
 * function left on that queue blocks the queue that would carry its own `cancel`.
 * The escape hatch is the platform's own `runOnQueue`, and this test pins which
 * functions take it: heavy work off the shared queue, control functions on it.
 *
 * This is a source-level assertion because the scheduling fact lives in the
 * module definition, not in behavior a host test can drive: the queue is chosen
 * when the definition is built, and both toolchains are device-only. It is
 * written to fail on the two ways the property actually breaks -- a heavy
 * function losing its worker, and a control function acquiring one -- and to
 * fail closed on a function it does not know about, so a new native entry point
 * cannot be added silently on either side of the line.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every `AsyncFunction` the module exposes, and whether it may block.
 *
 * `worker`: enters sherpa and blocks for as long as the model takes.
 * `control`: must stay reachable while a worker is blocked -- cancellation, pack
 * invalidation, and the short VAD frame calls that own their own lock.
 */
const FUNCTION_KIND = {
  initialize: "worker",
  listVoices: "worker",
  synthesizeToWavFile: "worker",
  createStreamingRecognizer: "worker",
  pushAudioFrame: "worker",
  finishStreaming: "worker",
  cancel: "control",
  releaseAssetsDir: "control",
  createVadDetector: "control",
  pushVadAudioFrame: "control",
  cancelVadDetector: "control",
};

/**
 * Read each `AsyncFunction("name")` and the queue it was declared on, by
 * scanning forward from the declaration to the next one and looking for a
 * `.runOnQueue(...)` in between.
 */
function readDeclaredQueues(source, { declaration, runOnQueue }) {
  const declarations = [...source.matchAll(declaration)];
  assert.ok(declarations.length > 0, "expected at least one AsyncFunction declaration");

  const queues = new Map();
  for (const [index, match] of declarations.entries()) {
    const start = match.index + match[0].length;
    const end = index + 1 < declarations.length ? declarations[index + 1].index : source.length;
    const body = source.slice(start, end);
    const queued = body.match(runOnQueue);
    queues.set(match[1], queued ? queued[1] : null);
  }
  return queues;
}

function assertQueueAssignment(platform, queues) {
  assert.deepEqual(
    [...queues.keys()].sort(),
    Object.keys(FUNCTION_KIND).sort(),
    `${platform}: the async functions this module exposes changed; classify each new one as worker or control`,
  );

  for (const [name, queue] of queues) {
    if (FUNCTION_KIND[name] === "worker") {
      assert.ok(
        queue,
        `${platform}: "${name}" blocks inside sherpa, so leaving it on the shared Expo queue blocks the queue that carries its own cancel`,
      );
      continue;
    }
    assert.equal(
      queue,
      null,
      `${platform}: "${name}" must stay on the shared Expo queue -- moving it onto ${queue} makes it queue behind the very work it is meant to preempt`,
    );
  }
}

test("iOS declares blocking sherpa work off the shared Expo async queue", () => {
  const source = readFileSync(path.join(packageRoot, "ios", "HappierSherpaNativeModule.swift"), "utf8");
  const queues = readDeclaredQueues(source, {
    declaration: /AsyncFunction\("([A-Za-z]+)"\)/g,
    runOnQueue: /\}\.runOnQueue\((\w+)\)/,
  });

  assertQueueAssignment("iOS", queues);

  // Separate workers, because a conversation runs both at once: the assistant is
  // speaking while the microphone stays open for barge-in.
  assert.equal(queues.get("synthesizeToWavFile"), "ttsQueue");
  assert.equal(queues.get("pushAudioFrame"), "asrQueue");
  assert.match(source, /private let ttsQueue = DispatchQueue\(label: "dev\.happier\.sherpa\.tts"/);
  assert.match(source, /private let asrQueue = DispatchQueue\(label: "dev\.happier\.sherpa\.asr"/);

  // A `.sync` onto a worker from the default queue blocks the default queue for
  // the whole call, which is the bug `runOnQueue` exists to avoid.
  assert.doesNotMatch(source, /ttsQueue\.sync|asrQueue\.sync/);
});

test("Android declares blocking sherpa work off the shared Expo async queue", () => {
  const source = readFileSync(
    path.join(packageRoot, "android", "src", "main", "java", "dev", "happier", "sherpa", "HappierSherpaNativeModule.kt"),
    "utf8",
  );
  const queues = readDeclaredQueues(source, {
    declaration: /AsyncFunction\("([A-Za-z]+)"\)/g,
    runOnQueue: /\}\.runOnQueue\((\w+)\.scope\)/,
  });

  assertQueueAssignment("Android", queues);

  assert.equal(queues.get("synthesizeToWavFile"), "ttsWorker");
  assert.equal(queues.get("pushAudioFrame"), "asrWorker");

  // Each worker is one dedicated thread, so a worker serializes its own engine's
  // calls the way the shared queue used to, without owning the cancel path.
  assert.match(source, /Executors\.newSingleThreadExecutor/);
  assert.match(source, /internal val ttsWorker = SherpaWorker\("happier-sherpa-tts"\)/);
  assert.match(source, /internal val asrWorker = SherpaWorker\("happier-sherpa-asr"\)/);

  // Teardown releases the native caches first, so a thread blocked inside sherpa
  // observes its cancel and unwinds instead of being shut down underneath.
  const destroy = source.match(/internal fun handleModuleDestroy\(\)[\s\S]*?\n  \}/);
  assert.ok(destroy, "expected handleModuleDestroy");
  assert.ok(
    destroy[0].indexOf("releaseAllNative()") < destroy[0].indexOf("ttsWorker.shutdown()"),
    "native caches must be released before the workers are shut down",
  );
});

test("pack invalidation retires both native engine kinds through one owner", () => {
  const jni = readFileSync(
    path.join(packageRoot, "android", "src", "main", "cpp", "HappierSherpaNativeJni.cpp"),
    "utf8",
  );
  const ios = readFileSync(path.join(packageRoot, "ios", "HappierSherpaOfflineTtsEngine.mm"), "utf8");
  const types = readFileSync(path.join(packageRoot, "src", "HappierSherpaNative.types.ts"), "utf8");

  // One JS entry point; two engine kinds behind it. A separate streaming-only
  // method would leave the TTS engine serving the superseded model.
  assert.match(types, /releaseAssetsDir\?\(params: \{ assetsDir: string \}\)/);
  assert.doesNotMatch(types, /releaseStreamingAssetsDir/);

  const androidRelease = jni.match(/nativeReleaseAssetsDir\([\s\S]*?\n\}/);
  assert.ok(androidRelease, "expected nativeReleaseAssetsDir");
  assert.match(androidRelease[0], /AsrJobs\(\)\.releaseAssetsDir\(dir\)/);
  assert.match(androidRelease[0], /Engines\(\)\.release\(dir\)/);
  // `retire`, not a bare cancel sweep: a synthesis that leased this engine just
  // before the invalidation must also be refused admission just after it.
  assert.match(androidRelease[0], /jobs\.retire\(\)/);

  // Both platforms lease the engine out of the shared cache rather than handing a
  // raw handle across the bridge, which is what lets an invalidation retire the
  // entry while a synthesis is still running on it.
  for (const [platform, source] of [["Android", jni], ["iOS", ios]]) {
    assert.match(
      source,
      /happier_sherpa::OfflineTtsEngineCache</,
      `${platform} offline TTS must be owned by the shared engine cache`,
    );
    assert.doesNotMatch(
      source,
      /SherpaOnnxDestroyOfflineTts\((?!\))(?!.*shared_ptr)[^)]*\)\s*;[\s\S]{0,40}\/\/ explicit/,
      `${platform} engines must be destroyed by their shared_ptr holder, never by an explicit call`,
    );
  }

  // A `jlong` engine handle crossing the bridge is the ownership model this
  // replaced: JS could hold a pointer the cache had already freed.
  assert.doesNotMatch(jni, /nativeCreateEngine|nativeDestroyEngine/);
  const kotlin = readFileSync(
    path.join(packageRoot, "android", "src", "main", "java", "dev", "happier", "sherpa", "HappierSherpaNativeModule.kt"),
    "utf8",
  );
  assert.doesNotMatch(kotlin, /enginesByAssetsDir/);
  // The offline-TTS externals are keyed by directory now. (VAD sessions keep a
  // handle on purpose: they are per-detector and not keyed by a model pack.)
  assert.match(kotlin, /external fun nativeEnsureEngine\(assetsDir: String\): Int/);
  assert.match(kotlin, /external fun nativeSynthesizeToWavFile\(assetsDir: String,/);
  assert.match(kotlin, /external fun nativeCancel\(jobId: String\)/);
  assert.doesNotMatch(kotlin, /external fun native(Create|Destroy)Engine\b/);
  assert.doesNotMatch(kotlin, /external fun nativeSynthesizeToWavFile\(handle: Long/);
});
