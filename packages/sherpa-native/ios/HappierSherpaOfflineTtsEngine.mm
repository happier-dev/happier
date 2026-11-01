#import "HappierSherpaOfflineTtsEngine.h"

#include <atomic>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

#include <sherpa-onnx/c-api/c-api.h>

namespace {

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

// Accepted synthesis jobs by id, from acceptance (still queued on the TTS queue) until the job ends. Cancel
// flags a queued or running job; ids it does not know (finished, never accepted, ASR jobs) are ignored, so the
// map never outgrows the jobs actually in flight.
std::mutex g_jobsMutex;
std::unordered_map<std::string, std::shared_ptr<JobState>> g_jobs;

NSError *CancelledError() {
  return [NSError errorWithDomain:@"HappierSherpaNative" code:8 userInfo:@{NSLocalizedDescriptionKey: @"Synthesis cancelled"}];
}

}  // namespace

@interface HappierSherpaOfflineTtsEngine () {
  const SherpaOnnxOfflineTts *_tts;
  std::string _assetsDir;
  std::string _modelPath;
  std::string _voicesPath;
  std::string _tokensPath;
  std::string _dataDirPath;
}
@end

@implementation HappierSherpaOfflineTtsEngine

- (instancetype)initWithAssetsDir:(NSString *)assetsDir error:(NSError **)error {
  self = [super init];
  if (!self) return nil;

  _tts = nullptr;

  _assetsDir = std::string([assetsDir UTF8String]);
  if (_assetsDir.empty()) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:2 userInfo:@{NSLocalizedDescriptionKey: @"assetsDir is empty"}];
    return nil;
  }

  _modelPath = _assetsDir + "/model.onnx";
  _voicesPath = _assetsDir + "/voices.bin";
  _tokensPath = _assetsDir + "/tokens.txt";
  _dataDirPath = _assetsDir + "/espeak-ng-data";

  if (!SherpaOnnxFileExists(_modelPath.c_str())) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:3 userInfo:@{NSLocalizedDescriptionKey: @"model.onnx not found"}];
    return nil;
  }
  if (!SherpaOnnxFileExists(_voicesPath.c_str())) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:4 userInfo:@{NSLocalizedDescriptionKey: @"voices.bin not found"}];
    return nil;
  }
  if (!SherpaOnnxFileExists(_tokensPath.c_str())) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:5 userInfo:@{NSLocalizedDescriptionKey: @"tokens.txt not found"}];
    return nil;
  }

  SherpaOnnxOfflineTtsConfig config;
  memset(&config, 0, sizeof(config));

  config.model.num_threads = 2;
  config.model.debug = 0;
  config.model.provider = "cpu";
  config.max_num_sentences = 1;
  config.silence_scale = 0.2f;

  config.model.kokoro.model = _modelPath.c_str();
  config.model.kokoro.voices = _voicesPath.c_str();
  config.model.kokoro.tokens = _tokensPath.c_str();
  config.model.kokoro.data_dir = _dataDirPath.c_str();
  config.model.kokoro.length_scale = 1.0f;
  config.model.kokoro.lexicon = nullptr;
  config.model.kokoro.lang = nullptr;

  const SherpaOnnxOfflineTts *tts = SherpaOnnxCreateOfflineTts(&config);
  if (!tts) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:6 userInfo:@{NSLocalizedDescriptionKey: @"Failed to initialize sherpa offline TTS"}];
    return nil;
  }

  _tts = tts;
  return self;
}

- (void)dealloc {
  if (_tts) {
    SherpaOnnxDestroyOfflineTts(_tts);
    _tts = nullptr;
  }
}

- (int32_t)sampleRate {
  if (!_tts) return 0;
  return SherpaOnnxOfflineTtsSampleRate(_tts);
}

- (int32_t)numSpeakers {
  if (!_tts) return 0;
  return SherpaOnnxOfflineTtsNumSpeakers(_tts);
}

+ (void)cancelJob:(NSString *)jobId {
  const std::string key([jobId UTF8String]);
  if (key.empty()) return;
  std::lock_guard<std::mutex> lock(g_jobsMutex);
  auto it = g_jobs.find(key);
  if (it == g_jobs.end()) return;
  it->second->cancelled.store(true);
}

+ (void)acceptJob:(NSString *)jobId {
  const std::string key([jobId UTF8String]);
  if (key.empty()) return;
  std::lock_guard<std::mutex> lock(g_jobsMutex);
  g_jobs[key] = std::make_shared<JobState>();
}

+ (void)forgetJob:(NSString *)jobId {
  const std::string key([jobId UTF8String]);
  if (key.empty()) return;
  std::lock_guard<std::mutex> lock(g_jobsMutex);
  g_jobs.erase(key);
}

- (BOOL)synthesizeToWavFileAtPath:(NSString *)wavPath
                             text:(NSString *)text
                              sid:(int32_t)sid
                            speed:(float)speed
                            jobId:(NSString *)jobId
                            error:(NSError **)error {
  if (!_tts) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:7 userInfo:@{NSLocalizedDescriptionKey: @"TTS not initialized"}];
    return NO;
  }

  const std::string jobKey([jobId UTF8String]);
  std::shared_ptr<JobState> state;
  {
    std::lock_guard<std::mutex> lock(g_jobsMutex);
    auto &entry = g_jobs[jobKey];
    if (!entry) entry = std::make_shared<JobState>();
    if (entry->cancelled.load()) {
      g_jobs.erase(jobKey);
      if (error) *error = CancelledError();
      return NO;
    }
    state = entry;
  }

  ProgressArg arg;
  arg.state = state.get();

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
      _tts, [text UTF8String], &genCfg, ProgressCallback, &arg);

  {
    std::lock_guard<std::mutex> lock(g_jobsMutex);
    g_jobs.erase(jobKey);
  }

  // A cancelled generation stops early and may still return the partial audio; never publish it.
  if (state->cancelled.load()) {
    if (audio) SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
    if (error) *error = CancelledError();
    return NO;
  }
  if (!audio) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:9 userInfo:@{NSLocalizedDescriptionKey: @"Synthesis failed"}];
    return NO;
  }

  const std::string out([wavPath UTF8String]);
  const int32_t ok = SherpaOnnxWriteWave(audio->samples, audio->n, audio->sample_rate, out.c_str());
  SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);

  if (!ok) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:10 userInfo:@{NSLocalizedDescriptionKey: @"Failed to write wav"}];
    return NO;
  }

  return YES;
}

@end
