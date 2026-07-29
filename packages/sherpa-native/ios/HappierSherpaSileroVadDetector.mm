#import "HappierSherpaSileroVadDetector.h"

#include <mutex>
#include <string>

#include <sherpa-onnx/c-api/c-api.h>

namespace {

std::string NsToStd(NSString *s) {
  if (!s) return std::string();
  const char *c = [s UTF8String];
  return std::string(c ? c : "");
}

bool Exists(const std::string &path) {
  return SherpaOnnxFileExists(path.c_str()) != 0;
}

}  // namespace

@interface HappierSherpaSileroVadDetector () {
  const SherpaOnnxVoiceActivityDetector *_vad;
  std::string _modelPath;
  std::mutex _mutex;
}
@end

@implementation HappierSherpaSileroVadDetector

- (instancetype)initWithModelPath:(NSString *)modelPath
                       sampleRate:(int32_t)sampleRate
                     minSpeechSec:(float)minSpeechSec
                    minSilenceSec:(float)minSilenceSec
                            error:(NSError * _Nullable * _Nullable)error {
  self = [super init];
  if (!self) return nil;

  _vad = nullptr;

  _modelPath = NsToStd(modelPath);
  if (_modelPath.empty() || !Exists(_modelPath)) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:410 userInfo:@{NSLocalizedDescriptionKey: @"Silero VAD model not found"}];
    return nil;
  }

  const int32_t sr = sampleRate > 0 ? sampleRate : 16000;
  const float minSpeech = minSpeechSec < 0 ? 0.0f : minSpeechSec;
  const float minSilence = minSilenceSec < 0 ? 0.0f : minSilenceSec;

  SherpaOnnxVadModelConfig cfg;
  memset(&cfg, 0, sizeof(cfg));

  cfg.sample_rate = sr;
  cfg.num_threads = 2;
  cfg.provider = "cpu";
  cfg.debug = 0;

  cfg.silero_vad.model = _modelPath.c_str();
  cfg.silero_vad.threshold = 0.5f;
  cfg.silero_vad.min_speech_duration = minSpeech;
  cfg.silero_vad.min_silence_duration = minSilence;
  cfg.silero_vad.window_size = 512;
  cfg.silero_vad.max_speech_duration = 30.0f;

  // If ten-vad is unused, leave its model empty.
  cfg.ten_vad.model = nullptr;

  const SherpaOnnxVoiceActivityDetector *vad = SherpaOnnxCreateVoiceActivityDetector(&cfg, /*buffer_size_in_seconds=*/60.0f);
  if (!vad) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:411 userInfo:@{NSLocalizedDescriptionKey: @"Failed to initialize sherpa-onnx voice activity detector"}];
    return nil;
  }

  _vad = vad;
  return self;
}

- (void)dealloc {
  [self close];
}

- (BOOL)acceptWaveform:(const float *)samples
                 count:(int32_t)count
        speechDetected:(BOOL *)speechDetected {
  std::lock_guard<std::mutex> lock(_mutex);
  if (speechDetected) *speechDetected = NO;
  if (!_vad || !samples || count <= 0) return NO;

  SherpaOnnxVoiceActivityDetectorAcceptWaveform(_vad, samples, count);
  if (speechDetected) {
    *speechDetected = SherpaOnnxVoiceActivityDetectorDetected(_vad) != 0;
  }

  if (SherpaOnnxVoiceActivityDetectorEmpty(_vad) != 0) {
    return NO;
  }

  // There is at least one speech segment queued. Emit once and clear.
  // Pop all queued segments for hygiene, then reset.
  while (SherpaOnnxVoiceActivityDetectorEmpty(_vad) == 0) {
    SherpaOnnxVoiceActivityDetectorPop(_vad);
  }

  SherpaOnnxVoiceActivityDetectorClear(_vad);
  SherpaOnnxVoiceActivityDetectorReset(_vad);
  return YES;
}

- (void)close {
  std::lock_guard<std::mutex> lock(_mutex);
  if (_vad) {
    SherpaOnnxDestroyVoiceActivityDetector(_vad);
    _vad = nullptr;
  }
}

@end
