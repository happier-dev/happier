#import "HappierSherpaOnlineAsrEngine.h"

#include <cmath>
#include <mutex>
#include <string>
#include <vector>

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

@interface HappierSherpaOnlineAsrEngine () {
  const SherpaOnnxOnlineRecognizer *_recognizer;
  std::string _assetsDir;
  std::string _tokensPath;
  std::string _encoderPath;
  std::string _decoderPath;
  std::string _joinerPath;
  std::string _language;
  int32_t _sampleRate;
  std::mutex _mutex;
}
@end

@interface HappierSherpaOnlineAsrStream () {
  const SherpaOnnxOnlineRecognizer *_recognizer;
  SherpaOnnxOnlineStream *_stream;
  std::mutex _mutex;
}
@end

@implementation HappierSherpaOnlineAsrEngine

- (instancetype)initWithAssetsDir:(NSString *)assetsDir
                       sampleRate:(int32_t)sampleRate
                         language:(NSString * _Nullable)language
                            error:(NSError * _Nullable * _Nullable)error {
  self = [super init];
  if (!self) return nil;

  _recognizer = nullptr;
  _assetsDir = NsToStd(assetsDir);
  _sampleRate = sampleRate > 0 ? sampleRate : 16000;
  _language = language ? NsToStd(language) : std::string();

  if (_assetsDir.empty()) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:200 userInfo:@{NSLocalizedDescriptionKey: @"assetsDir is empty"}];
    return nil;
  }

  _tokensPath = _assetsDir + "/tokens.txt";
  _encoderPath = _assetsDir + "/encoder.onnx";
  _decoderPath = _assetsDir + "/decoder.onnx";
  _joinerPath = _assetsDir + "/joiner.onnx";

  if (!Exists(_tokensPath) || !Exists(_encoderPath) || !Exists(_decoderPath) || !Exists(_joinerPath)) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:201 userInfo:@{NSLocalizedDescriptionKey: @"Missing required streaming ASR assets"}];
    return nil;
  }

  SherpaOnnxOnlineRecognizerConfig config;
  memset(&config, 0, sizeof(config));

  config.feat_config.sample_rate = _sampleRate;
  config.feat_config.feature_dim = 80;

  config.model_config.tokens = _tokensPath.c_str();
  config.model_config.num_threads = 2;
  config.model_config.debug = 0;
  config.model_config.provider = "cpu";
  // Most sherpa-onnx streaming Zipformer transducer models do not require an explicit model_type.
  // Leave it empty so sherpa can select defaults based on the provided ONNX graphs.
  config.model_config.model_type = "";
  config.model_config.modeling_unit = nullptr;
  config.model_config.bpe_vocab = nullptr;

  config.model_config.transducer.encoder = _encoderPath.c_str();
  config.model_config.transducer.decoder = _decoderPath.c_str();
  config.model_config.transducer.joiner = _joinerPath.c_str();

  config.decoder_config.decoding_method = "greedy_search";
  config.decoder_config.num_active_paths = 4;
  config.decoder_config.enable_endpoint = 1;

  // Default endpointing tuned for streaming turn-taking. Units are seconds.
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
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:202 userInfo:@{NSLocalizedDescriptionKey: @"Failed to initialize sherpa online ASR recognizer"}];
    return nil;
  }

  _recognizer = recognizer;
  return self;
}

- (void)dealloc {
  if (_recognizer) {
    SherpaOnnxDestroyOnlineRecognizer(_recognizer);
    _recognizer = nullptr;
  }
}

- (HappierSherpaOnlineAsrStream * _Nullable)createStreamWithError:(NSError * _Nullable * _Nullable)error {
  std::lock_guard<std::mutex> lock(_mutex);
  if (!_recognizer) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:203 userInfo:@{NSLocalizedDescriptionKey: @"ASR recognizer not initialized"}];
    return nil;
  }
  SherpaOnnxOnlineStream *stream = SherpaOnnxCreateOnlineStream(_recognizer);
  if (!stream) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:204 userInfo:@{NSLocalizedDescriptionKey: @"Failed to create ASR stream"}];
    return nil;
  }
  HappierSherpaOnlineAsrStream *wrapper = [HappierSherpaOnlineAsrStream new];
  wrapper->_recognizer = _recognizer;
  wrapper->_stream = stream;
  return wrapper;
}

@end

@implementation HappierSherpaOnlineAsrStream

- (NSDictionary *)pushPcm16Data:(NSData *)pcm16le
                     sampleRate:(int32_t)sampleRate
                       channels:(int32_t)channels
                          error:(NSError * _Nullable * _Nullable)error {
  std::lock_guard<std::mutex> lock(_mutex);
  if (!_recognizer || !_stream) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:210 userInfo:@{NSLocalizedDescriptionKey: @"ASR stream not initialized"}];
    return @{};
  }

  const int32_t sr = sampleRate > 0 ? sampleRate : 16000;
  const int32_t ch = channels > 0 ? channels : 1;

  const int16_t *samples16 = reinterpret_cast<const int16_t *>(pcm16le.bytes);
  const size_t count16 = pcm16le.length / sizeof(int16_t);
  if (!samples16 || count16 == 0) {
    return @{@"text": @"", @"isEndpoint": @NO};
  }

  std::vector<float> mono;
  if (ch == 1) {
    mono.resize(count16);
    for (size_t i = 0; i < count16; i++) {
      mono[i] = static_cast<float>(samples16[i]) / 32768.0f;
    }
  } else {
    const size_t frames = count16 / static_cast<size_t>(ch);
    mono.resize(frames);
    for (size_t i = 0; i < frames; i++) {
      int32_t sum = 0;
      for (int32_t c = 0; c < ch; c++) {
        sum += samples16[i * static_cast<size_t>(ch) + static_cast<size_t>(c)];
      }
      mono[i] = (static_cast<float>(sum) / static_cast<float>(ch)) / 32768.0f;
    }
  }

  SherpaOnnxOnlineStreamAcceptWaveform(_stream, sr, mono.data(), static_cast<int32_t>(mono.size()));

  while (SherpaOnnxIsOnlineStreamReady(_recognizer, _stream)) {
    SherpaOnnxDecodeOnlineStream(_recognizer, _stream);
  }

  const SherpaOnnxOnlineRecognizerResult *result = SherpaOnnxGetOnlineStreamResult(_recognizer, _stream);
  std::string text;
  if (result && result->text) {
    text = std::string(result->text);
  }
  if (result) {
    SherpaOnnxDestroyOnlineRecognizerResult(result);
  }

  const bool endpoint = SherpaOnnxOnlineStreamIsEndpoint(_recognizer, _stream) != 0;

  return @{
    @"text": [NSString stringWithUTF8String:text.c_str()],
    @"isEndpoint": endpoint ? @YES : @NO,
  };
}

- (NSString *)finishWithError:(NSError * _Nullable * _Nullable)error {
  std::lock_guard<std::mutex> lock(_mutex);
  if (!_recognizer || !_stream) {
    if (error) *error = [NSError errorWithDomain:@"HappierSherpaNative" code:211 userInfo:@{NSLocalizedDescriptionKey: @"ASR stream not initialized"}];
    return @"";
  }

  SherpaOnnxOnlineStreamInputFinished(_stream);
  while (SherpaOnnxIsOnlineStreamReady(_recognizer, _stream)) {
    SherpaOnnxDecodeOnlineStream(_recognizer, _stream);
  }

  const SherpaOnnxOnlineRecognizerResult *result = SherpaOnnxGetOnlineStreamResult(_recognizer, _stream);
  std::string text;
  if (result && result->text) {
    text = std::string(result->text);
  }
  if (result) {
    SherpaOnnxDestroyOnlineRecognizerResult(result);
  }

  SherpaOnnxDestroyOnlineStream(_stream);
  _stream = nullptr;

  return [NSString stringWithUTF8String:text.c_str()];
}

- (void)cancel {
  std::lock_guard<std::mutex> lock(_mutex);
  if (_stream) {
    SherpaOnnxDestroyOnlineStream(_stream);
    _stream = nullptr;
  }
}

- (void)dealloc {
  [self cancel];
}

@end
