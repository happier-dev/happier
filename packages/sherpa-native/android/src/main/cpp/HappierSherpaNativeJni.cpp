#include <jni.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <unordered_map>
#include <memory>
#include <string>
#include <vector>

#include <android/log.h>

#include "sherpa-onnx/c-api/c-api.h"
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

struct Engine {
  const SherpaOnnxOfflineTts *tts = nullptr;
  std::string assetsDir;
  std::string modelPath;
  std::string voicesPath;
  std::string tokensPath;
  std::string dataDirPath;

  happier_sherpa::TtsJobRegistry jobs;

  ~Engine() {
    if (tts) {
      SherpaOnnxDestroyOfflineTts(tts);
      tts = nullptr;
    }
  }
};

struct AsrEngine {
  const SherpaOnnxOnlineRecognizer *recognizer = nullptr;
  std::string assetsDir;
  std::string tokensPath;
  std::string encoderPath;
  std::string decoderPath;
  std::string joinerPath;

  ~AsrEngine() {
    if (recognizer) {
      SherpaOnnxDestroyOnlineRecognizer(recognizer);
      recognizer = nullptr;
    }
  }
};

struct AsrStreamState {
  AsrEngine *engine = nullptr;
  SherpaOnnxOnlineStream *stream = nullptr;
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

std::mutex g_asrMutex;
std::unordered_map<std::string, std::unique_ptr<AsrEngine>> g_asrEnginesByAssetsDir;
std::unordered_map<std::string, AsrStreamState> g_asrStreamsByJobId;

Engine *CreateEngine(const std::string &assetsDir) {
  auto engine = std::make_unique<Engine>();
  engine->assetsDir = assetsDir;
  engine->modelPath = assetsDir + "/model.onnx";
  engine->voicesPath = assetsDir + "/voices.bin";
  engine->tokensPath = assetsDir + "/tokens.txt";
  engine->dataDirPath = assetsDir + "/espeak-ng-data";

  if (!SherpaOnnxFileExists(engine->modelPath.c_str()) ||
      !SherpaOnnxFileExists(engine->voicesPath.c_str()) ||
      !SherpaOnnxFileExists(engine->tokensPath.c_str())) {
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

  config.model.kokoro.model = engine->modelPath.c_str();
  config.model.kokoro.voices = engine->voicesPath.c_str();
  config.model.kokoro.tokens = engine->tokensPath.c_str();
  config.model.kokoro.data_dir = engine->dataDirPath.c_str();
  config.model.kokoro.length_scale = 1.0f;
  config.model.kokoro.lexicon = nullptr;
  config.model.kokoro.lang = nullptr;

  const SherpaOnnxOfflineTts *tts = SherpaOnnxCreateOfflineTts(&config);
  if (!tts) {
    __android_log_print(ANDROID_LOG_ERROR, kLogTag, "Failed to initialize sherpa offline TTS");
    return nullptr;
  }

  engine->tts = tts;
  return engine.release();
}

AsrEngine *GetOrCreateAsrEngine(const std::string &assetsDir) {
  std::lock_guard<std::mutex> lock(g_asrMutex);
  auto it = g_asrEnginesByAssetsDir.find(assetsDir);
  if (it != g_asrEnginesByAssetsDir.end()) {
    return it->second.get();
  }

  auto engine = std::make_unique<AsrEngine>();
  engine->assetsDir = assetsDir;
  engine->tokensPath = assetsDir + "/tokens.txt";
  engine->encoderPath = assetsDir + "/encoder.onnx";
  engine->decoderPath = assetsDir + "/decoder.onnx";
  engine->joinerPath = assetsDir + "/joiner.onnx";

  if (!SherpaOnnxFileExists(engine->tokensPath.c_str()) ||
      !SherpaOnnxFileExists(engine->encoderPath.c_str()) ||
      !SherpaOnnxFileExists(engine->decoderPath.c_str()) ||
      !SherpaOnnxFileExists(engine->joinerPath.c_str())) {
    __android_log_print(ANDROID_LOG_ERROR, kLogTag, "Missing required streaming ASR assets in %s", assetsDir.c_str());
    return nullptr;
  }

  SherpaOnnxOnlineRecognizerConfig config;
  memset(&config, 0, sizeof(config));

  config.feat_config.sample_rate = 16000;
  config.feat_config.feature_dim = 80;

  config.model_config.tokens = engine->tokensPath.c_str();
  config.model_config.num_threads = 2;
  config.model_config.debug = 0;
  config.model_config.provider = "cpu";
  // Leave empty so Sherpa can infer from provided model fields (keeps this compatible
  // with other streaming transducer packs without hard-coding a single model type).
  config.model_config.model_type = "";
  config.model_config.modeling_unit = nullptr;
  config.model_config.bpe_vocab = nullptr;

  config.model_config.transducer.encoder = engine->encoderPath.c_str();
  config.model_config.transducer.decoder = engine->decoderPath.c_str();
  config.model_config.transducer.joiner = engine->joinerPath.c_str();

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

  engine->recognizer = recognizer;
  AsrEngine *out = engine.get();
  g_asrEnginesByAssetsDir[assetsDir] = std::move(engine);
  return out;
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

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeCreateEngine(JNIEnv *env, jclass /*clazz*/, jstring assetsDir) {
  const std::string dir = JStringToUtf8(env, assetsDir);
  if (dir.empty()) return 0;
  Engine *engine = CreateEngine(dir);
  return reinterpret_cast<jlong>(engine);
}

extern "C" JNIEXPORT void JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeDestroyEngine(JNIEnv * /*env*/, jclass /*clazz*/, jlong handle) {
  auto *engine = reinterpret_cast<Engine *>(handle);
  delete engine;
}

extern "C" JNIEXPORT jint JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeGetSampleRate(JNIEnv * /*env*/, jclass /*clazz*/, jlong handle) {
  auto *engine = reinterpret_cast<Engine *>(handle);
  if (!engine || !engine->tts) return 0;
  return SherpaOnnxOfflineTtsSampleRate(engine->tts);
}

extern "C" JNIEXPORT jint JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeGetNumSpeakers(JNIEnv * /*env*/, jclass /*clazz*/, jlong handle) {
  auto *engine = reinterpret_cast<Engine *>(handle);
  if (!engine || !engine->tts) return 0;
  return SherpaOnnxOfflineTtsNumSpeakers(engine->tts);
}

extern "C" JNIEXPORT jint JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeSynthesizeToWavFile(
    JNIEnv *env,
    jclass /*clazz*/,
    jlong handle,
    jstring text,
    jint sid,
    jfloat speed,
    jstring outWavPath,
    jstring jobId) {
  auto *engine = reinterpret_cast<Engine *>(handle);
  if (!engine || !engine->tts) return 0;

  const std::string jobKey = JStringToUtf8(env, jobId);
  const std::string outPath = JStringToUtf8(env, outWavPath);
  const std::string inputText = JStringToUtf8(env, text);
  if (jobKey.empty() || outPath.empty() || inputText.empty()) return 0;

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
  return ok && !wasCancelled ? 1 : 0;
}

extern "C" JNIEXPORT void JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeCancel(JNIEnv *env, jclass /*clazz*/, jlong handle, jstring jobId) {
  auto *engine = reinterpret_cast<Engine *>(handle);
  if (!engine) return;
  const std::string jobKey = JStringToUtf8(env, jobId);
  if (jobKey.empty()) return;
  engine->jobs.cancel(jobKey);
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

  AsrEngine *engine = GetOrCreateAsrEngine(dir);
  if (!engine || !engine->recognizer) return 0;

  std::lock_guard<std::mutex> lock(g_asrMutex);
  auto it = g_asrStreamsByJobId.find(jobKey);
  if (it != g_asrStreamsByJobId.end()) {
    if (it->second.stream) {
      SherpaOnnxDestroyOnlineStream(it->second.stream);
    }
    g_asrStreamsByJobId.erase(it);
  }

  SherpaOnnxOnlineStream *stream = SherpaOnnxCreateOnlineStream(engine->recognizer);
  if (!stream) return 0;
  g_asrStreamsByJobId[jobKey] = AsrStreamState{engine, stream};
  return 1;
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
  if (jobKey.empty() || !pcm16le) return MakePushFrameResult(env, "", false);

  AsrStreamState state;
  {
    std::lock_guard<std::mutex> lock(g_asrMutex);
    auto it = g_asrStreamsByJobId.find(jobKey);
    if (it == g_asrStreamsByJobId.end() || !it->second.engine || !it->second.stream) {
      return MakePushFrameResult(env, "", false);
    }
    state = it->second;
  }

  const jsize len = env->GetArrayLength(pcm16le);
  if (len <= 0) return MakePushFrameResult(env, "", false);

  std::vector<int16_t> samples16(static_cast<size_t>(len) / sizeof(int16_t));
  env->GetByteArrayRegion(pcm16le, 0, static_cast<jsize>(samples16.size() * sizeof(int16_t)),
                          reinterpret_cast<jbyte *>(samples16.data()));

  const auto mono = Pcm16LeToMonoFloats(samples16.data(), samples16.size(), channels);
  if (!mono.empty()) {
    SherpaOnnxOnlineStreamAcceptWaveform(state.stream, sampleRate > 0 ? sampleRate : 16000, mono.data(),
                                         static_cast<int32_t>(mono.size()));
  }

  while (SherpaOnnxIsOnlineStreamReady(state.engine->recognizer, state.stream)) {
    SherpaOnnxDecodeOnlineStream(state.engine->recognizer, state.stream);
  }

  const SherpaOnnxOnlineRecognizerResult *result = SherpaOnnxGetOnlineStreamResult(state.engine->recognizer, state.stream);
  std::string text;
  if (result && result->text) text = std::string(result->text);
  if (result) SherpaOnnxDestroyOnlineRecognizerResult(result);

  const bool endpoint = SherpaOnnxOnlineStreamIsEndpoint(state.engine->recognizer, state.stream) != 0;
  return MakePushFrameResult(env, text, endpoint);
}

extern "C" JNIEXPORT jstring JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeFinishStreaming(JNIEnv *env, jclass /*clazz*/, jstring jobId) {
  const std::string jobKey = JStringToUtf8(env, jobId);
  if (jobKey.empty()) return env->NewStringUTF("");

  AsrStreamState state;
  {
    std::lock_guard<std::mutex> lock(g_asrMutex);
    auto it = g_asrStreamsByJobId.find(jobKey);
    if (it == g_asrStreamsByJobId.end()) return env->NewStringUTF("");
    state = it->second;
    g_asrStreamsByJobId.erase(it);
  }

  if (!state.engine || !state.stream) return env->NewStringUTF("");

  SherpaOnnxOnlineStreamInputFinished(state.stream);
  while (SherpaOnnxIsOnlineStreamReady(state.engine->recognizer, state.stream)) {
    SherpaOnnxDecodeOnlineStream(state.engine->recognizer, state.stream);
  }

  const SherpaOnnxOnlineRecognizerResult *result = SherpaOnnxGetOnlineStreamResult(state.engine->recognizer, state.stream);
  std::string text;
  if (result && result->text) text = std::string(result->text);
  if (result) SherpaOnnxDestroyOnlineRecognizerResult(result);

  SherpaOnnxDestroyOnlineStream(state.stream);
  return env->NewStringUTF(text.c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeCancelStreaming(JNIEnv *env, jclass /*clazz*/, jstring jobId) {
  const std::string jobKey = JStringToUtf8(env, jobId);
  if (jobKey.empty()) return;
  std::lock_guard<std::mutex> lock(g_asrMutex);
  auto it = g_asrStreamsByJobId.find(jobKey);
  if (it == g_asrStreamsByJobId.end()) return;
  if (it->second.stream) {
    SherpaOnnxDestroyOnlineStream(it->second.stream);
  }
  g_asrStreamsByJobId.erase(it);
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
