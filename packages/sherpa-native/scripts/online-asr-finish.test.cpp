#include <algorithm>
#include <cassert>
#include <string>
#include <vector>

#include "HappierSherpaOnlineAsr.h"

// Sherpa is the external inference boundary. Model the remaining encoder chunk:
// marking input finished alone does not make it ready without acoustic context.
struct SherpaOnnxOnlineStream {
  int32_t inputSampleRate = 16000;
  mutable std::vector<float> tail;
  mutable bool inputFinished = false;
  mutable std::string text = "turn";
};
struct SherpaOnnxOnlineRecognizer {};

void SherpaOnnxOnlineStreamAcceptWaveform(const SherpaOnnxOnlineStream *stream,
                                        int32_t sampleRate, const float *samples, int32_t count) {
  assert(!stream->inputFinished);
  assert(sampleRate == stream->inputSampleRate);
  stream->tail.insert(stream->tail.end(), samples, samples + count);
}

void SherpaOnnxOnlineStreamInputFinished(const SherpaOnnxOnlineStream *stream) {
  stream->inputFinished = true;
}

int32_t SherpaOnnxIsOnlineStreamReady(const SherpaOnnxOnlineRecognizer *, const SherpaOnnxOnlineStream *stream) {
  return stream->inputFinished && stream->text == "turn" &&
      stream->tail.size() >= static_cast<size_t>(stream->inputSampleRate) * 3 / 10;
}

void SherpaOnnxDecodeOnlineStream(const SherpaOnnxOnlineRecognizer *, const SherpaOnnxOnlineStream *stream) {
  stream->text = "turn ending";
}

int main() {
  SherpaOnnxOnlineRecognizer recognizer;
  for (const int32_t sampleRate : {16000, 48000}) {
    SherpaOnnxOnlineStream stream;
    stream.inputSampleRate = sampleRate;
    happier_sherpa::FinishOnlineTransducer(&recognizer, &stream, sampleRate);
    assert(stream.text == "turn ending");
    assert(stream.tail.size() == static_cast<size_t>(sampleRate) * 3 / 10);
    assert(std::all_of(stream.tail.begin(), stream.tail.end(), [](float sample) { return sample == 0; }));
  }
}
