#include <jni.h>

#include <atomic>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include <android/log.h>

#include "sherpa-onnx/c-api/c-api.h"
#include "HappierSherpaOnlineAsr.h"

namespace {

constexpr const char *kLogTag = "HappierSherpaNative";

struct JobState {
  std::atomic<bool> cancelled{false};
};

struct ProgressArg {
  JobState *state;
};

int32_t ProgressCallback(const float * /*samples*/, int32_t /*n*/, float /*p*/, void *arg) {
  if (!arg) return 1;
  auto *parg = reinterpret_cast<ProgressArg *>(arg);
  if (!parg->state) return 1;
  return parg->state->cancelled.load() ? 0 : 1;
}

// Accepted synthesis jobs by id, from acceptance (still queued on the TTS executor) until the job ends. Cancel
// flags a queued or running job; ids it does not know (finished, never accepted, ASR jobs) are ignored, so the
// map never outgrows the jobs actually in flight.
std::mutex g_jobsMutex;
std::unordered_map<std::string, std::shared_ptr<JobState>> g_jobs;

constexpr jint kSynthesisFailed = 0;
constexpr jint kSynthesisOk = 1;
constexpr jint kSynthesisCancelled = 2;

struct Engine {
  const SherpaOnnxOfflineTts *tts = nullptr;
  std::string assetsDir;
  std::string modelPath;
  std::string voicesPath;
  std::string tokensPath;
  std::string dataDirPath;

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

// Streams share ownership of their engine so releasing an assets dir never frees a recognizer that an
// active stream still decodes with; the engine is destroyed when its last stream ends.
struct AsrStreamState {
  std::shared_ptr<AsrEngine> engine;
  const SherpaOnnxOnlineStream *stream = nullptr;
  int32_t inputSampleRate = 16000;
  // Text of segments already closed by an endpoint. The stream is reset at each endpoint (otherwise the
  // utterance-length rule keeps reporting an endpoint on every frame), and callers receive the whole
  // transcript so far rather than only the open segment.
  std::string committedText;
};

std::string JoinTranscript(const std::string &committed, const std::string &segment) {
  if (committed.empty()) return segment;
  if (segment.empty()) return committed;
  return committed + " " + segment;
}

std::string ReadStreamText(const SherpaOnnxOnlineRecognizer *recognizer, const SherpaOnnxOnlineStream *stream) {
  const SherpaOnnxOnlineRecognizerResult *result = SherpaOnnxGetOnlineStreamResult(recognizer, stream);
  std::string text;
  if (result && result->text) text = std::string(result->text);
  if (result) SherpaOnnxDestroyOnlineRecognizerResult(result);
  return text;
}

std::mutex g_asrMutex;
std::unordered_map<std::string, std::shared_ptr<AsrEngine>> g_asrEnginesByAssetsDir;
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

std::shared_ptr<AsrEngine> GetOrCreateAsrEngine(const std::string &assetsDir) {
  std::lock_guard<std::mutex> lock(g_asrMutex);
  auto it = g_asrEnginesByAssetsDir.find(assetsDir);
  if (it != g_asrEnginesByAssetsDir.end()) {
    return it->second;
  }

  auto engine = std::make_shared<AsrEngine>();
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

  // Mirrors ios/HappierSherpaOnlineAsrEngine.mm. Unset (zero) fields take sherpa-onnx defaults.
  config.decoding_method = "greedy_search";
  config.max_active_paths = 4;
  config.enable_endpoint = 1;

  // Default endpointing tuned for streaming turn-taking. Units are seconds.
  config.rule1_min_trailing_silence = 1.2f;
  config.rule2_min_trailing_silence = 0.6f;
  // Rule 3 fires on utterance length alone, i.e. mid-speech. The stream resets on every endpoint and
  // the UI ends the hands-free turn on it, so only the trailing-silence rules may report one. Zero
  // would select the sherpa-onnx default (20 s), so disable it with an unreachable length.
  config.rule3_min_utterance_length = std::numeric_limits<float>::max();

  const SherpaOnnxOnlineRecognizer *recognizer = SherpaOnnxCreateOnlineRecognizer(&config);
  if (!recognizer) {
    __android_log_print(ANDROID_LOG_ERROR, kLogTag, "Failed to initialize sherpa online recognizer");
    return nullptr;
  }

  engine->recognizer = recognizer;
  g_asrEnginesByAssetsDir[assetsDir] = engine;
  return engine;
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
  if (!engine || !engine->tts) return kSynthesisFailed;

  const std::string jobKey = JStringToUtf8(env, jobId);
  const std::string outPath = JStringToUtf8(env, outWavPath);
  const std::string inputText = JStringToUtf8(env, text);
  if (jobKey.empty() || outPath.empty() || inputText.empty()) return kSynthesisFailed;

  std::shared_ptr<JobState> state;
  {
    std::lock_guard<std::mutex> lock(g_jobsMutex);
    auto &entry = g_jobs[jobKey];
    if (!entry) entry = std::make_shared<JobState>();
    if (entry->cancelled.load()) {
      g_jobs.erase(jobKey);
      return kSynthesisCancelled;
    }
    state = entry;
  }

  ProgressArg arg{state.get()};

  SherpaOnnxGenerationConfig genCfg;
  memset(&genCfg, 0, sizeof(genCfg));
  genCfg.silence_scale = 0.2f;
  genCfg.speed = speed;
  genCfg.sid = sid;
  genCfg.extra = nullptr;

  const SherpaOnnxGeneratedAudio *audio = SherpaOnnxOfflineTtsGenerateWithConfig(
      engine->tts, inputText.c_str(), &genCfg, ProgressCallback, &arg);

  {
    std::lock_guard<std::mutex> lock(g_jobsMutex);
    g_jobs.erase(jobKey);
  }

  // A cancelled generation stops early and may still return the partial audio; never publish it.
  if (state->cancelled.load()) {
    if (audio) SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
    return kSynthesisCancelled;
  }
  if (!audio) return kSynthesisFailed;

  const int32_t ok = SherpaOnnxWriteWave(audio->samples, audio->n, audio->sample_rate, outPath.c_str());
  SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
  return ok ? kSynthesisOk : kSynthesisFailed;
}

extern "C" JNIEXPORT void JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeCancel(JNIEnv *env, jclass /*clazz*/, jstring jobId) {
  const std::string jobKey = JStringToUtf8(env, jobId);
  if (jobKey.empty()) return;
  std::lock_guard<std::mutex> lock(g_jobsMutex);
  auto it = g_jobs.find(jobKey);
  if (it == g_jobs.end()) return;
  it->second->cancelled.store(true);
}

// Registers a synthesis job when it is accepted, before it waits on the TTS executor, so a cancel that arrives
// while it is queued is not lost.
extern "C" JNIEXPORT void JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeAcceptSynthesis(JNIEnv *env, jclass /*clazz*/, jstring jobId) {
  const std::string jobKey = JStringToUtf8(env, jobId);
  if (jobKey.empty()) return;
  std::lock_guard<std::mutex> lock(g_jobsMutex);
  g_jobs[jobKey] = std::make_shared<JobState>();
}

// Drops an accepted job that ended without running (failed before synthesis or could not be scheduled).
extern "C" JNIEXPORT void JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeForgetSynthesis(JNIEnv *env, jclass /*clazz*/, jstring jobId) {
  const std::string jobKey = JStringToUtf8(env, jobId);
  if (jobKey.empty()) return;
  std::lock_guard<std::mutex> lock(g_jobsMutex);
  g_jobs.erase(jobKey);
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

  std::shared_ptr<AsrEngine> engine = GetOrCreateAsrEngine(dir);
  if (!engine || !engine->recognizer) return 0;

  std::lock_guard<std::mutex> lock(g_asrMutex);
  auto it = g_asrStreamsByJobId.find(jobKey);
  if (it != g_asrStreamsByJobId.end()) {
    if (it->second.stream) {
      SherpaOnnxDestroyOnlineStream(it->second.stream);
    }
    g_asrStreamsByJobId.erase(it);
  }

  const SherpaOnnxOnlineStream *stream = SherpaOnnxCreateOnlineStream(engine->recognizer);
  if (!stream) return 0;
  g_asrStreamsByJobId[jobKey] = AsrStreamState{std::move(engine), stream, 16000, {}};
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

  // Streams are created, used and destroyed only on the ASR executor, so the entry outlives this call.
  AsrStreamState *state = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_asrMutex);
    auto it = g_asrStreamsByJobId.find(jobKey);
    if (it == g_asrStreamsByJobId.end() || !it->second.engine || !it->second.stream) {
      return MakePushFrameResult(env, "", false);
    }
    state = &it->second;
  }

  const jsize len = env->GetArrayLength(pcm16le);
  if (len <= 0) return MakePushFrameResult(env, "", false);

  std::vector<int16_t> samples16(static_cast<size_t>(len) / sizeof(int16_t));
  env->GetByteArrayRegion(pcm16le, 0, static_cast<jsize>(samples16.size() * sizeof(int16_t)),
                          reinterpret_cast<jbyte *>(samples16.data()));

  const auto mono = Pcm16LeToMonoFloats(samples16.data(), samples16.size(), channels);
  const SherpaOnnxOnlineRecognizer *recognizer = state->engine->recognizer;
  if (!mono.empty()) {
    state->inputSampleRate = sampleRate > 0 ? sampleRate : 16000;
    SherpaOnnxOnlineStreamAcceptWaveform(state->stream, state->inputSampleRate, mono.data(),
                                         static_cast<int32_t>(mono.size()));
  }

  while (SherpaOnnxIsOnlineStreamReady(recognizer, state->stream)) {
    SherpaOnnxDecodeOnlineStream(recognizer, state->stream);
  }

  const std::string segment = ReadStreamText(recognizer, state->stream);
  const bool endpoint = SherpaOnnxOnlineStreamIsEndpoint(recognizer, state->stream) != 0;
  const std::string transcript = JoinTranscript(state->committedText, segment);
  if (endpoint) {
    state->committedText = transcript;
    SherpaOnnxOnlineStreamReset(recognizer, state->stream);
  }
  return MakePushFrameResult(env, transcript, endpoint);
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

  happier_sherpa::FinishOnlineTransducer(state.engine->recognizer, state.stream, state.inputSampleRate);

  const std::string text = JoinTranscript(state.committedText, ReadStreamText(state.engine->recognizer, state.stream));

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

// Drops the cached ASR engine for an assets dir so the next stream loads the pack's current files. Streams
// already running keep their engine alive until they finish.
extern "C" JNIEXPORT void JNICALL
Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeReleaseAsrEngine(JNIEnv *env, jclass /*clazz*/, jstring assetsDir) {
  const std::string dir = JStringToUtf8(env, assetsDir);
  if (dir.empty()) return;
  std::shared_ptr<AsrEngine> released;
  {
    std::lock_guard<std::mutex> lock(g_asrMutex);
    auto it = g_asrEnginesByAssetsDir.find(dir);
    if (it == g_asrEnginesByAssetsDir.end()) return;
    released = std::move(it->second);
    g_asrEnginesByAssetsDir.erase(it);
  }
}
