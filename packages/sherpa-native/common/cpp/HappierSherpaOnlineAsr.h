#pragma once

#include <sherpa-onnx/c-api/c-api.h>
#include <vector>

namespace happier_sherpa {

inline void FinishOnlineTransducer(const SherpaOnnxOnlineRecognizer *recognizer,
                                  const SherpaOnnxOnlineStream *stream,
                                  int32_t inputSampleRate) {
  // v1.12.25's streaming-transducer recipe needs 0.3 seconds of acoustic context
  // to decode the last words before input finishes. Preserve the stream's rate:
  // an existing Sherpa resampler rejects switching sample rates.
  // https://github.com/k2-fsa/sherpa-onnx/blob/v1.12.25/c-api-examples/decode-file-c-api.c
  const std::vector<float> tail(static_cast<size_t>(inputSampleRate) * 3 / 10, 0.0f);
  SherpaOnnxOnlineStreamAcceptWaveform(stream, inputSampleRate, tail.data(), static_cast<int32_t>(tail.size()));
  SherpaOnnxOnlineStreamInputFinished(stream);
  while (SherpaOnnxIsOnlineStreamReady(recognizer, stream)) {
    SherpaOnnxDecodeOnlineStream(recognizer, stream);
  }
}

}  // namespace happier_sherpa
