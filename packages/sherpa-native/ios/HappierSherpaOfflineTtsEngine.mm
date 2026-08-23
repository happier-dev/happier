#import "HappierSherpaOfflineTtsEngine.h"
#import "HappierSherpaOfflineTtsEngineCache.h"
#import "HappierSherpaTtsJobRegistry.h"

#include <cstring>
#include <memory>
#include <string>

#include <sherpa-onnx/c-api/c-api.h>

namespace {

/**
 * One cached offline-TTS engine: the sherpa handle plus the cancellation
 * registry for the jobs synthesizing against it. Held by `shared_ptr` in the
 * shared cache, so the handle is destroyed by whichever holder releases last --
 * never underneath a synthesis that is already inside sherpa's generation
 * callback.
 */
struct TtsEngine {
  const SherpaOnnxOfflineTts *tts = nullptr;
  happier_sherpa::TtsJobRegistry jobs;

  ~TtsEngine() {
    if (tts) {
      SherpaOnnxDestroyOfflineTts(tts);
      tts = nullptr;
    }
  }
};

using EngineCache = happier_sherpa::OfflineTtsEngineCache<TtsEngine>;

EngineCache &Engines() {
  static EngineCache cache;
  return cache;
}

struct ProgressArg {
  happier_sherpa::TtsJobState *state;
};

int32_t ProgressCallback(const float * /*samples*/, int32_t /*n*/, float /*p*/, void *arg) {
  if (!arg) return 1;
  auto *parg = reinterpret_cast<ProgressArg *>(arg);
  if (!parg->state) return 1;
  return parg->state->cancelled.load() ? 0 : 1;
}

std::string NsToStd(NSString *s) {
  if (!s) return std::string();
  const char *c = [s UTF8String];
  return std::string(c ? c : "");
}

void SetError(NSError * _Nullable * _Nullable error, NSInteger code, NSString *message) {
  if (error) {
    *error = [NSError errorWithDomain:@"HappierSherpaNative" code:code userInfo:@{NSLocalizedDescriptionKey: message}];
  }
}

std::shared_ptr<TtsEngine> CreateEngine(const std::string &assetsDir, NSError * _Nullable * _Nullable error) {
  const std::string modelPath = assetsDir + "/model.onnx";
  const std::string voicesPath = assetsDir + "/voices.bin";
  const std::string tokensPath = assetsDir + "/tokens.txt";
  const std::string dataDirPath = assetsDir + "/espeak-ng-data";

  if (!SherpaOnnxFileExists(modelPath.c_str())) {
    SetError(error, 3, @"model.onnx not found");
    return nullptr;
  }
  if (!SherpaOnnxFileExists(voicesPath.c_str())) {
    SetError(error, 4, @"voices.bin not found");
    return nullptr;
  }
  if (!SherpaOnnxFileExists(tokensPath.c_str())) {
    SetError(error, 5, @"tokens.txt not found");
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
    SetError(error, 6, @"Failed to initialize sherpa offline TTS");
    return nullptr;
  }

  auto engine = std::make_shared<TtsEngine>();
  engine->tts = tts;
  return engine;
}

/**
 * Lease the engine for `assetsDir`, building it on first use. The cache owns the
 * whole find/create/publish sequence: creation runs outside its lock, because it
 * loads a model and would block invalidation for seconds, and the cache refuses
 * the publication when a pack invalidation overtook that load.
 */
std::shared_ptr<TtsEngine> LeaseEngine(const std::string &assetsDir, NSError * _Nullable * _Nullable error) {
  if (assetsDir.empty()) {
    SetError(error, 2, @"assetsDir is empty");
    return nullptr;
  }

  const auto engine = Engines().leaseOrCreate(assetsDir, [&] { return CreateEngine(assetsDir, error); });
  if (!engine && error && !*error) {
    // Creation succeeded but the pack it was built from was retired while it
    // loaded, so there is no creation error to report. Distinguished from a
    // missing-assets failure because retrying against the new bytes is the
    // right response.
    SetError(error, 11, @"Model pack was invalidated while the TTS engine was loading");
  }
  return engine;
}

}  // namespace

@implementation HappierSherpaOfflineTtsEngine

+ (BOOL)prepareAssetsDir:(NSString *)assetsDir error:(NSError * _Nullable * _Nullable)error {
  return LeaseEngine(NsToStd(assetsDir), error) != nullptr;
}

+ (int32_t)numSpeakersForAssetsDir:(NSString *)assetsDir {
  const auto engine = LeaseEngine(NsToStd(assetsDir), nullptr);
  if (!engine || !engine->tts) return 0;
  return SherpaOnnxOfflineTtsNumSpeakers(engine->tts);
}

+ (BOOL)synthesizeToWavFileAtPath:(NSString *)wavPath
                        assetsDir:(NSString *)assetsDir
                             text:(NSString *)text
                              sid:(int32_t)sid
                            speed:(float)speed
                            jobId:(NSString *)jobId
                       sampleRate:(int32_t *)outSampleRate
                            error:(NSError * _Nullable * _Nullable)error {
  if (outSampleRate) *outSampleRate = 0;

  // The lease is held for the whole synthesis, so an invalidation racing this
  // call retires the cache entry and cancels the job without freeing the engine.
  const auto engine = LeaseEngine(NsToStd(assetsDir), error);
  if (!engine || !engine->tts) {
    if (error && !*error) SetError(error, 7, @"TTS not initialized");
    return NO;
  }

  const std::string jobKey = NsToStd(jobId);
  bool wasAlreadyCancelled = false;
  happier_sherpa::TtsJobState *statePtr = engine->jobs.beginJob(jobKey, &wasAlreadyCancelled);
  if (wasAlreadyCancelled || !statePtr) {
    SetError(error, 8, @"Synthesis cancelled");
    return NO;
  }

  ProgressArg arg;
  arg.state = statePtr;

  const SherpaOnnxGenerationConfig genCfg = {
      .silence_scale = 0.2f,
      .speed = speed,
      .sid = sid,
      .reference_audio = nullptr,
      .reference_audio_len = 0,
      .reference_sample_rate = 0,
      .reference_text = nullptr,
      .num_steps = 0,
      .extra = nullptr,
  };

  const SherpaOnnxGeneratedAudio *audio = SherpaOnnxOfflineTtsGenerateWithConfig(
      engine->tts, [text UTF8String], &genCfg, ProgressCallback, &arg);

  if (!audio) {
    const bool wasCancelled = engine->jobs.finishJob(jobKey);
    SetError(error, wasCancelled ? 8 : 9, wasCancelled ? @"Synthesis cancelled" : @"Synthesis failed");
    return NO;
  }

  if (statePtr->cancelled.load()) {
    engine->jobs.finishJob(jobKey);
    SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
    SetError(error, 8, @"Synthesis cancelled");
    return NO;
  }

  const std::string out = NsToStd(wavPath);
  const int32_t ok = SherpaOnnxWriteWave(audio->samples, audio->n, audio->sample_rate, out.c_str());
  const bool wasCancelled = engine->jobs.finishJob(jobKey);
  SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);

  if (wasCancelled) {
    SetError(error, 8, @"Synthesis cancelled");
    return NO;
  }
  if (!ok) {
    SetError(error, 10, @"Failed to write wav");
    return NO;
  }

  if (outSampleRate) *outSampleRate = SherpaOnnxOfflineTtsSampleRate(engine->tts);
  return YES;
}

+ (void)cancelJob:(NSString *)jobId {
  const std::string jobKey = NsToStd(jobId);
  if (jobKey.empty()) return;
  for (const auto &engine : Engines().snapshot()) {
    engine->jobs.cancel(jobKey);
  }
}

+ (NSUInteger)releaseAssetsDir:(NSString *)assetsDir {
  const std::string dir = NsToStd(assetsDir);
  if (dir.empty()) return 0;
  // Retiring the entry is immediate for the next caller; marking the jobs is what
  // stops work already inside sherpa's generation callback from finishing against
  // the superseded model.
  const auto retired = Engines().release(dir);
  if (!retired) return 0;
  retired->jobs.retire();
  return 1;
}

+ (NSUInteger)releaseAll {
  const auto retired = Engines().releaseAll();
  for (const auto &engine : retired) {
    engine->jobs.retire();
  }
  return static_cast<NSUInteger>(retired.size());
}

@end
