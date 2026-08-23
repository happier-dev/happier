#include <jni.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include <android/log.h>

#include "sherpa-onnx/c-api/c-api.h"
#include "HappierSherpaAsrStreamRegistry.h"
#include "HappierSherpaOfflineTtsEngineCache.h"
#include "HappierSherpaTtsJobRegistry.h"

namespace {

constexpr const char *kLogTag = "HappierSherpaNative";

struct ProgressArg {
  happier_sherpa::TtsJobState *state;
};

int32_t ProgressCallback(const float * /*samples*/, int32_t /*n*/, float /*p*/, void *arg) {
  if (!arg) return 1;
  auto *parg = reinterpret_cast<ProgressArg *>(arg);
  if (!parg->state) return 1;
  return parg->state->cancelled.load() ? 0 : 1;
}

/**
 * One cached offline-TTS engine: the sherpa handle plus the cancellation
 * registry for the jobs synthesizing against it. Held by `shared_ptr` in the
 * shared cache, so the handle is destroyed by whichever holder releases last --
 * never underneath a synthesis already inside sherpa's generation callback.
 */
struct Engine {
  const SherpaOnnxOfflineTts *tts = nullptr;
  happier_sherpa::TtsJobRegistry jobs;

  ~Engine() {
    if (tts) {
      SherpaOnnxDestroyOfflineTts(tts);
      tts = nullptr;
    }
  }
};

struct VadSession {
  const SherpaOnnxVoiceActivityDetector *vad = nullptr;

  ~VadSession() {
    if (vad) {
      SherpaOnnxDestroyVoiceActivityDetector(vad);
      vad = nullptr;
    }
  }
};

// Streaming ASR jobs and the recognizers they decode against are owned by the
// shared registry, so a push holds both handles for the whole decode while a
// concurrent cancel or a pack invalidation only marks the job and drops the
// registry's reference.
using AsrStreams = happier_sherpa::AsrStreamRegistry<const SherpaOnnxOnlineRecognizer, SherpaOnnxOnlineStream>;

AsrStreams &AsrJobs() {
  static AsrStreams registry;
  return registry;
}

std::shared_ptr<Engine> CreateEngine(const std::string &assetsDir) {
  const std::string modelPath = assetsDir + "/model.onnx";
  const std::string voicesPath = assetsDir + "/voices.bin";
  const std::string tokensPath = assetsDir + "/tokens.txt";
  const std::string dataDirPath = assetsDir + "/espeak-ng-data";

  if (!SherpaOnnxFileExists(modelPath.c_str()) ||
      !SherpaOnnxFileExists(voicesPath.c_str()) ||
      !SherpaOnnxFileExists(tokensPath.c_str())) {
    __android_log_print(ANDROID_LOG_ERROR, kLogTag, "Missing required Kokoro assets in %s", assetsDir.c_str());
    return nullptr;
  }

  SherpaOnnxOfflineTtsConfig config;
  memset(&config, 0, sizeof(config));

  config.model.num_threads = 2;
  config.model.debug = 0;
  config.model.provider = "cpu";
  config.max_num_sentences = 1;
  config.silence_scale = 0.2f;

  config.model.kokoro.model = modelPath.c_str();
  config.model.kokoro.voices = voicesPath.c_str();
  config.model.kokoro.tokens = tokensPath.c_str();
  config.model.kokoro.data_dir = dataDirPath.c_str();
  config.model.kokoro.length_scale = 1.0f;
  config.model.kokoro.lexicon = nullptr;
  config.model.kokoro.lang = nullptr;

  const SherpaOnnxOfflineTts *tts = SherpaOnnxCreateOfflineTts(&config);
  if (!tts) {
    __android_log_print(ANDROID_LOG_ERROR, kLogTag, "Failed to initialize sherpa offline TTS");
    return nullptr;
  }

  auto engine = std::make_shared<Engine>();
  engine->tts = tts;
  return engine;
}

using EngineCache = happier_sherpa::OfflineTtsEngineCache<Engine>;

EngineCache &Engines() {
  static EngineCache cache;
  return cache;
}

/**
 * Lease the engine for `assetsDir`, building it on first use. The cache owns the
 * whole find/create/publish sequence: creation runs outside its lock, because it
 * loads a model and would block invalidation for seconds, and the cache refuses
 * the publication when a pack invalidation overtook that load. Returns nullptr
 * both when creation failed and when the pack it was built from was retired
 * meanwhile; the caller treats either as a failed start.
 */
std::shared_ptr<Engine> LeaseEngine(const std::string &assetsDir) {
  return Engines().leaseOrCreate(assetsDir, [&] { return CreateEngine(assetsDir); });
}

std::shared_ptr<const SherpaOnnxOnlineRecognizer> CreateAsrRecognizer(const std::string &assetsDir) {
  const std::string tokensPath = assetsDir + "/tokens.txt";
  const std::string encoderPath = assetsDir + "/encoder.onnx";
  const std::string decoderPath = assetsDir + "/decoder.onnx";
  const std::string joinerPath = assetsDir + "/joiner.onnx";

  if (!SherpaOnnxFileExists(tokensPath.c_str()) ||
      !SherpaOnnxFileExists(encoderPath.c_str()) ||
      !SherpaOnnxFileExists(decoderPath.c_str()) ||
      !SherpaOnnxFileExists(joinerPath.c_str())) {
    __android_log_print(ANDROID_LOG_ERROR, kLogTag, "Missing required streaming ASR assets in %s", assetsDir.c_str());
    return nullptr;
  }

  SherpaOnnxOnlineRecognizerConfig config;
  memset(&config, 0, sizeof(config));

  config.feat_config.sample_rate = 16000;
  config.feat_config.feature_dim = 80;

  config.model_config.tokens = tokensPath.c_str();
  config.model_config.num_threads = 2;
  config.model_config.debug = 0;
  config.model_config.provider = "cpu";
  // Leave empty so Sherpa can infer from provided model fields (keeps this compatible
  // with other streaming transducer packs without hard-coding a single model type).
  config.model_config.model_type = "";
  config.model_config.modeling_unit = nullptr;
  config.model_config.bpe_vocab = nullptr;

  config.model_config.transducer.encoder = encoderPath.c_str();
  config.model_config.transducer.decoder = decoderPath.c_str();
  config.model_config.transducer.joiner = joinerPath.c_str();

  config.decoder_config.decoding_method = "greedy_search";
  config.decoder_config.num_active_paths = 4;
  config.decoder_config.enable_endpoint = 1;
  config.decoder_config.hotwords_file = nullptr;
  config.decoder_config.hotwords_score = 0.0f;
  config.decoder_config.rule_fsts = nullptr;
  config.decoder_config.rule_fsts_score = 0.0f;
  config.decoder_config.blank_penalty = 0.0f;

  config.endpoint_config.rule1.must_contain_nonsilence = 1;
  config.endpoint_config.rule1.min_trailing_silence = 1.2f;
  config.endpoint_config.rule1.min_utterance_length = 0.0f;
  config.endpoint_config.rule2.must_contain_nonsilence = 1;
  config.endpoint_config.rule2.min_trailing_silence = 0.6f;
  config.endpoint_config.rule2.min_utterance_length = 2.0f;
  config.endpoint_config.rule3.must_contain_nonsilence = 0;
  config.endpoint_config.rule3.min_trailing_silence = 0.0f;
  config.endpoint_config.rule3.min_utterance_length = 15.0f;

  const SherpaOnnxOnlineRecognizer *recognizer = SherpaOnnxCreateOnlineRecognizer(&config);
  if (!recognizer) {
    __android_log_print(ANDROID_LOG_ERROR, kLogTag, "Failed to initialize sherpa online recognizer");
    return nullptr;
  }

  return std::shared_ptr<const SherpaOnnxOnlineRecognizer>(recognizer, SherpaOnnxDestroyOnlineRecognizer);
}

/** The recognizer lease counterpart of `LeaseEngine`, with the same contract. */
std::shared_ptr<const SherpaOnnxOnlineRecognizer> GetOrCreateAsrRecognizer(const std::string &assetsDir) {
  return AsrJobs().leaseOrCreateRecognizer(assetsDir, [&] { return CreateAsrRecognizer(assetsDir); });
}

std::string JStringToUtf8(JNIEnv *env, jstring str) {
  if (!str) return std::string();
  const char *chars = env->GetStringUTFChars(str, nullptr);
  std::string out(chars ? chars : "");
  if (chars) env->ReleaseStringUTFChars(str, chars);
  return out;
}

std::vector<float> Pcm16LeToMonoFloats(const int16_t *samples, size_t n, int32_t channels) {
  if (!samples || n == 0) return {};
  if (channels <= 1) {
    std::vector<float> out(n);
    for (size_t i = 0; i < n; i++) {
      out[i] = static_cast<float>(samples[i]) / 32768.0f;
    }
    return out;
  }

  const size_t frames = n / static_cast<size_t>(channels);
  std::vector<float> out(frames);
  for (size_t i = 0; i < frames; i++) {
    int32_t sum = 0;
    for (int32_t c = 0; c < channels; c++) {
      sum += samples[i * static_cast<size_t>(channels) + static_cast<size_t>(c)];
    }
    out[i] = (static_cast<float>(sum) / static_cast<float>(channels)) / 32768.0f;
  }
  return out;
}

VadSession *CreateVadSession(const std::string &modelPath, int32_t sampleRate, float minSpeechSec, float minSilenceSec) {
  auto session = std::make_unique<VadSession>();
  if (modelPath.empty() || !SherpaOnnxFileExists(modelPath.c_str())) {
    __android_log_print(ANDROID_LOG_ERROR, kLogTag, "Missing required Silero VAD model at %s", modelPath.c_str());
    return nullptr;
  }

  SherpaOnnxVadModelConfig config;
  memset(&config, 0, sizeof(config));
  config.sample_rate = sampleRate > 0 ? sampleRate : 16000;
  config.num_threads = 2;
  config.provider = "cpu";
  config.debug = 0;
  config.silero_vad.model = modelPath.c_str();
  config.silero_vad.threshold = 0.5f;
  config.silero_vad.min_speech_duration = minSpeechSec < 0 ? 0.0f : minSpeechSec;
  config.silero_vad.min_silence_duration = minSilenceSec < 0 ? 0.0f : minSilenceSec;
  config.silero_vad.window_size = 512;
  config.silero_vad.max_speech_duration = 30.0f;
  config.ten_vad.model = nullptr;

  const SherpaOnnxVoiceActivityDetector *vad =
      SherpaOnnxCreateVoiceActivityDetector(&config, /*buffer_size_in_seconds=*/60.0f);
  if (!vad) {
    __android_log_print(ANDROID_LOG_ERROR, kLogTag, "Failed to initialize sherpa VAD");
    return nullptr;
  }

  session->vad = vad;
  return session.release();
}

jintArray MakeIntPair(JNIEnv *env, jint first, jint second) {
  jintArray out = env->NewIntArray(2);
  if (!out) return nullptr;
  const jint values[2] = {first, second};
  env->SetIntArrayRegion(out, 0, 2, values);
  return out;
}

jobject MakePushFrameResult(JNIEnv *env, const std::string &text, bool endpoint) {
  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!mapClass) return nullptr;
  jmethodID ctor = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID put = env->GetMethodID(mapClass, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  jobject map = env->NewObject(mapClass, ctor);

  jstring keyText = env->NewStringUTF("text");
  jstring valText = env->NewStringUTF(text.c_str());
  env->CallObjectMethod(map, put, keyText, valText);
  env->DeleteLocalRef(keyText);
  env->DeleteLocalRef(valText);

  jstring keyEndpoint = env->NewStringUTF("isEndpoint");
  jclass boolClass = env->FindClass("java/lang/Boolean");
  jmethodID boolCtor = env->GetMethodID(boolClass, "<init>", "(Z)V");
  jobject valEndpoint = env->NewObject(boolClass, boolCtor, endpoint ? JNI_TRUE : JNI_FALSE);
  env->CallObjectMethod(map, put, keyEndpoint, valEndpoint);
  env->DeleteLocalRef(keyEndpoint);
  env->DeleteLocalRef(valEndpoint);

  return map;
}

/**
 * The tail-decode outcome, as the discriminated result the JS bridge parses:
 * `{ status: "finalized", text }`, `{ status: "cancelled" }`, or
 * `{ status: "missing" }`. Only a finalized outcome carries text, because only a
 * finalized outcome has a transcript -- collapsing the other two into empty text
 * is what let the JS controller promote its last interim partial to a final.
 */
jobject MakeFinishResult(JNIEnv *env, const char *status, const char *text) {
  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!mapClass) return nullptr;
  jmethodID ctor = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID put = env->GetMethodID(mapClass, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  jobject map = env->NewObject(mapClass, ctor);

  jstring keyStatus = env->NewStringUTF("status");
  jstring valStatus = env->NewStringUTF(status);
  env->CallObjectMethod(map, put, keyStatus, valStatus);
  env->DeleteLocalRef(keyStatus);
  env->DeleteLocalRef(valStatus);

  if (text) {
    jstring keyText = env->NewStringUTF("text");
    jstring valText = env->NewStringUTF(text);
    env->CallObjectMethod(map, put, keyText, valText);
    env->DeleteLocalRef(keyText);
    env->DeleteLocalRef(valText);
  }

  return map;
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeEnsureEngine(JNIEnv *env, jclass /*clazz*/, jstring assetsDir) {
  return LeaseEngine(JStringToUtf8(env, assetsDir)) ? 1 : 0;
}

extern "C" JNIEXPORT jint JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeGetNumSpeakers(JNIEnv *env, jclass /*clazz*/, jstring assetsDir) {
  const auto engine = LeaseEngine(JStringToUtf8(env, assetsDir));
  if (!engine || !engine->tts) return 0;
  return SherpaOnnxOfflineTtsNumSpeakers(engine->tts);
}

/** Returns the engine's sample rate on success and 0 on any failure. */
extern "C" JNIEXPORT jint JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeSynthesizeToWavFile(
    JNIEnv *env,
    jclass /*clazz*/,
    jstring assetsDir,
    jstring text,
    jint sid,
    jfloat speed,
    jstring outWavPath,
    jstring jobId) {
  const std::string jobKey = JStringToUtf8(env, jobId);
  const std::string outPath = JStringToUtf8(env, outWavPath);
  const std::string inputText = JStringToUtf8(env, text);
  if (jobKey.empty() || outPath.empty() || inputText.empty()) return 0;

  // The lease is held for the whole synthesis, so an invalidation racing this
  // call retires the cache entry and cancels the job without freeing the engine.
  const auto engine = LeaseEngine(JStringToUtf8(env, assetsDir));
  if (!engine || !engine->tts) return 0;

  bool wasAlreadyCancelled = false;
  happier_sherpa::TtsJobState *statePtr = engine->jobs.beginJob(jobKey, &wasAlreadyCancelled);
  if (wasAlreadyCancelled || !statePtr) {
    return 0;
  }

  ProgressArg arg{statePtr};

  SherpaOnnxGenerationConfig genCfg;
  memset(&genCfg, 0, sizeof(genCfg));
  genCfg.silence_scale = 0.2f;
  genCfg.speed = speed;
  genCfg.sid = sid;
  genCfg.extra = nullptr;

  const SherpaOnnxGeneratedAudio *audio = SherpaOnnxOfflineTtsGenerateWithConfig(
      engine->tts, inputText.c_str(), &genCfg, ProgressCallback, &arg);

  if (!audio) {
    engine->jobs.finishJob(jobKey);
    return 0;
  }

  if (statePtr->cancelled.load()) {
    engine->jobs.finishJob(jobKey);
    SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
    return 0;
  }

  const int32_t ok = SherpaOnnxWriteWave(audio->samples, audio->n, audio->sample_rate, outPath.c_str());
  const bool wasCancelled = engine->jobs.finishJob(jobKey);
  SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
  if (!ok || wasCancelled) return 0;
  return SherpaOnnxOfflineTtsSampleRate(engine->tts);
}

/**
 * Mark `jobId` cancelled in both engine kinds. Every registry owns its locking,
 * so this lands while a worker thread is still inside a synthesis or a decode --
 * it never waits for the work it is cancelling.
 */
extern "C" JNIEXPORT void JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeCancel(JNIEnv *env, jclass /*clazz*/, jstring jobId) {
  const std::string jobKey = JStringToUtf8(env, jobId);
  if (jobKey.empty()) return;
  for (const auto &engine : Engines().snapshot()) {
    engine->jobs.cancel(jobKey);
  }
  AsrJobs().cancelJob(jobKey);
}

extern "C" JNIEXPORT jint JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeCreateStreamingRecognizer(
    JNIEnv *env,
    jclass /*clazz*/,
    jstring jobId,
    jstring assetsDir,
    jint /*sampleRate*/,
    jint /*channels*/,
    jstring /*language*/) {
  const std::string jobKey = JStringToUtf8(env, jobId);
  const std::string dir = JStringToUtf8(env, assetsDir);
  if (jobKey.empty() || dir.empty()) return 0;

  auto recognizer = GetOrCreateAsrRecognizer(dir);
  if (!recognizer) return 0;

  SherpaOnnxOnlineStream *stream = SherpaOnnxCreateOnlineStream(recognizer.get());
  if (!stream) return 0;

  const auto job = AsrJobs().beginJob(
      jobKey, dir, std::move(recognizer),
      std::shared_ptr<SherpaOnnxOnlineStream>(stream, SherpaOnnxDestroyOnlineStream));
  return job ? 1 : 0;
}

extern "C" JNIEXPORT jobject JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativePushAudioFrame(
    JNIEnv *env,
    jclass /*clazz*/,
    jstring jobId,
    jbyteArray pcm16le,
    jint sampleRate,
    jint channels) {
  const std::string jobKey = JStringToUtf8(env, jobId);
  if (jobKey.empty() || !pcm16le) return nullptr;

  // Holding the job keeps the stream and its recognizer alive for this whole
  // decode, so a cancel racing this call can only mark it. A job the registry no
  // longer holds is reported as absent (null) rather than as an empty decode, so
  // a session whose pack was invalidated stops instead of going quiet.
  const auto job = AsrJobs().findJob(jobKey);
  if (!job) return nullptr;
  // A cancelled or draining job is still registered, but its stream no longer
  // takes audio; report an empty decode rather than feeding a closed stream.
  if (job->cancelled() || job->finishing()) return MakePushFrameResult(env, "", false);

  const jsize len = env->GetArrayLength(pcm16le);
  if (len <= 0) return MakePushFrameResult(env, "", false);

  std::vector<int16_t> samples16(static_cast<size_t>(len) / sizeof(int16_t));
  env->GetByteArrayRegion(pcm16le, 0, static_cast<jsize>(samples16.size() * sizeof(int16_t)),
                          reinterpret_cast<jbyte *>(samples16.data()));

  const auto mono = Pcm16LeToMonoFloats(samples16.data(), samples16.size(), channels);
  if (!mono.empty()) {
    SherpaOnnxOnlineStreamAcceptWaveform(job->stream(), sampleRate > 0 ? sampleRate : 16000, mono.data(),
                                         static_cast<int32_t>(mono.size()));
  }

  while (!job->cancelled() && SherpaOnnxIsOnlineStreamReady(job->recognizer(), job->stream())) {
    SherpaOnnxDecodeOnlineStream(job->recognizer(), job->stream());
  }
  if (job->cancelled()) return MakePushFrameResult(env, "", false);

  const SherpaOnnxOnlineRecognizerResult *result = SherpaOnnxGetOnlineStreamResult(job->recognizer(), job->stream());
  std::string text;
  if (result && result->text) text = std::string(result->text);
  if (result) SherpaOnnxDestroyOnlineRecognizerResult(result);

  const bool endpoint = SherpaOnnxOnlineStreamIsEndpoint(job->recognizer(), job->stream()) != 0;
  return MakePushFrameResult(env, text, endpoint);
}

/**
 * Drain the tail of `jobId`, reporting which outcome actually happened. A
 * finalized empty utterance -- silence -- is a successful empty transcript; a
 * cancelled or absent job is not, and must not be reported as one.
 */
extern "C" JNIEXPORT jobject JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeFinishStreaming(JNIEnv *env, jclass /*clazz*/, jstring jobId) {
  const std::string jobKey = JStringToUtf8(env, jobId);
  if (jobKey.empty()) return MakeFinishResult(env, "missing", nullptr);

  // Claiming the tail decode keeps the job registered, so a cancel or a pack
  // invalidation arriving while it drains still reaches it. This scope holds the
  // only remaining reference once it is retired, so the stream dies with it.
  const auto job = AsrJobs().beginFinish(jobKey);
  // Nothing live under this id: it was cancelled, its pack was invalidated, or
  // another caller is already draining it. There is no transcript to report.
  if (!job) return MakeFinishResult(env, "missing", nullptr);

  if (job->cancelled()) {
    AsrJobs().endFinish(jobKey, job);
    return MakeFinishResult(env, "cancelled", nullptr);
  }

  SherpaOnnxOnlineStreamInputFinished(job->stream());
  while (!job->cancelled() && SherpaOnnxIsOnlineStreamReady(job->recognizer(), job->stream())) {
    SherpaOnnxDecodeOnlineStream(job->recognizer(), job->stream());
  }
  if (job->cancelled()) {
    AsrJobs().endFinish(jobKey, job);
    return MakeFinishResult(env, "cancelled", nullptr);
  }

  std::string text;
  const SherpaOnnxOnlineRecognizerResult *result =
      SherpaOnnxGetOnlineStreamResult(job->recognizer(), job->stream());
  if (result && result->text) text = std::string(result->text);
  if (result) SherpaOnnxDestroyOnlineRecognizerResult(result);

  AsrJobs().endFinish(jobKey, job);
  return MakeFinishResult(env, "finalized", text.c_str());
}

/**
 * Retire everything keyed on `assetsDir` -- the streaming recognizer, the jobs
 * decoding against it, and the offline TTS engine -- so a pack whose bytes are
 * about to be replaced or deleted stops being served from memory. Returns
 * `[cancelledJobs, releasedEngines]`.
 */
extern "C" JNIEXPORT jintArray JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeReleaseAssetsDir(
    JNIEnv *env,
    jclass /*clazz*/,
    jstring assetsDir) {
  const std::string dir = JStringToUtf8(env, assetsDir);
  jint counts[2] = {0, 0};
  if (!dir.empty()) {
    counts[0] = static_cast<jint>(AsrJobs().releaseAssetsDir(dir));
    if (const auto retired = Engines().release(dir)) {
      // Retiring the entry is immediate for the next caller; marking the jobs is
      // what stops work already inside sherpa's generation callback from
      // finishing against the superseded model.
      retired->jobs.retire();
      counts[1] = 1;
    }
  }
  return MakeIntPair(env, counts[0], counts[1]);
}

/** Teardown counterpart of `nativeReleaseAssetsDir`, across every cached pack. */
extern "C" JNIEXPORT jintArray JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeReleaseAll(JNIEnv *env, jclass /*clazz*/) {
  const jint cancelledJobs = static_cast<jint>(AsrJobs().releaseAll());
  const auto retired = Engines().releaseAll();
  for (const auto &engine : retired) {
    engine->jobs.retire();
  }
  return MakeIntPair(env, cancelledJobs, static_cast<jint>(retired.size()));
}

extern "C" JNIEXPORT jlong JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeCreateVadSession(
    JNIEnv *env,
    jclass /*clazz*/,
    jstring modelPath,
    jint sampleRate,
    jfloat minSpeechSec,
    jfloat minSilenceSec) {
  const std::string path = JStringToUtf8(env, modelPath);
  if (path.empty()) return 0;
  VadSession *session = CreateVadSession(path, sampleRate, minSpeechSec, minSilenceSec);
  return reinterpret_cast<jlong>(session);
}

extern "C" JNIEXPORT void JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeDestroyVadSession(
    JNIEnv * /*env*/,
    jclass /*clazz*/,
    jlong handle) {
  auto *session = reinterpret_cast<VadSession *>(handle);
  delete session;
}

extern "C" JNIEXPORT jint JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeVadAcceptPcm16(
    JNIEnv *env,
    jclass /*clazz*/,
    jlong handle,
    jshortArray pcm16,
    jint count,
    jint channels) {
  auto *session = reinterpret_cast<VadSession *>(handle);
  if (!session || !session->vad || !pcm16 || count <= 0) {
    return 0;
  }

  const jsize available = env->GetArrayLength(pcm16);
  const jsize sampleCount = std::min<jsize>(available, count);
  if (sampleCount <= 0) {
    return 0;
  }

  std::vector<int16_t> samples16(static_cast<size_t>(sampleCount));
  env->GetShortArrayRegion(pcm16, 0, sampleCount, reinterpret_cast<jshort *>(samples16.data()));

  const auto mono = Pcm16LeToMonoFloats(samples16.data(), samples16.size(), channels);
  if (mono.empty()) {
    return 0;
  }

  SherpaOnnxVoiceActivityDetectorAcceptWaveform(session->vad, mono.data(), static_cast<int32_t>(mono.size()));
  jint result = SherpaOnnxVoiceActivityDetectorDetected(session->vad) != 0 ? 1 : 0;
  if (SherpaOnnxVoiceActivityDetectorEmpty(session->vad) != 0) {
    return result;
  }

  result |= 2;

  while (SherpaOnnxVoiceActivityDetectorEmpty(session->vad) == 0) {
    SherpaOnnxVoiceActivityDetectorPop(session->vad);
  }
  SherpaOnnxVoiceActivityDetectorClear(session->vad);
  SherpaOnnxVoiceActivityDetectorReset(session->vad);
  return result;
}
