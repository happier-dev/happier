// Subset of sherpa-onnx C API required for offline TTS (Kokoro) on Android.
//
// Source of truth: sherpa-onnx/c-api/c-api.h (upstream).
// We vendor the exact struct layouts we pass across the ABI boundary to avoid
// relying on opaque pointers for configuration.
//
// Copyright (c) 2023 Xiaomi Corporation
// SPDX-License-Identifier: Apache-2.0

#ifndef HAPPIER_SHERPA_ONNX_C_API_OFFLINE_TTS_H_
#define HAPPIER_SHERPA_ONNX_C_API_OFFLINE_TTS_H_

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int32_t SherpaOnnxFileExists(const char *filename);

// ============================================================
// Offline Text-to-Speech
// ============================================================
typedef struct SherpaOnnxOfflineTtsVitsModelConfig {
  const char *model;
  const char *lexicon;
  const char *tokens;
  const char *data_dir;

  float noise_scale;
  float noise_scale_w;
  float length_scale;
  const char *dict_dir;
} SherpaOnnxOfflineTtsVitsModelConfig;

typedef struct SherpaOnnxOfflineTtsMatchaModelConfig {
  const char *acoustic_model;
  const char *vocoder;
  const char *lexicon;
  const char *tokens;
  const char *data_dir;

  float noise_scale;
  float length_scale;
  const char *dict_dir;
} SherpaOnnxOfflineTtsMatchaModelConfig;

typedef struct SherpaOnnxOfflineTtsKokoroModelConfig {
  const char *model;
  const char *voices;
  const char *tokens;
  const char *data_dir;

  float length_scale;
  const char *dict_dir;
  const char *lexicon;
  const char *lang;
} SherpaOnnxOfflineTtsKokoroModelConfig;

typedef struct SherpaOnnxOfflineTtsKittenModelConfig {
  const char *model;
  const char *voices;
  const char *tokens;
  const char *data_dir;

  float length_scale;
} SherpaOnnxOfflineTtsKittenModelConfig;

typedef struct SherpaOnnxOfflineTtsZipvoiceModelConfig {
  const char *tokens;
  const char *encoder;
  const char *decoder;
  const char *vocoder;
  const char *data_dir;
  const char *lexicon;
  float feat_scale;
  float t_shift;
  float target_rms;
  float guidance_scale;
} SherpaOnnxOfflineTtsZipvoiceModelConfig;

typedef struct SherpaOnnxOfflineTtsPocketModelConfig {
  const char *lm_flow;
  const char *lm_main;
  const char *encoder;
  const char *decoder;
  const char *text_conditioner;
  const char *vocab_json;
  const char *token_scores_json;
} SherpaOnnxOfflineTtsPocketModelConfig;

typedef struct SherpaOnnxOfflineTtsModelConfig {
  SherpaOnnxOfflineTtsVitsModelConfig vits;
  int32_t num_threads;
  int32_t debug;
  const char *provider;
  SherpaOnnxOfflineTtsMatchaModelConfig matcha;
  SherpaOnnxOfflineTtsKokoroModelConfig kokoro;
  SherpaOnnxOfflineTtsKittenModelConfig kitten;
  SherpaOnnxOfflineTtsZipvoiceModelConfig zipvoice;
  SherpaOnnxOfflineTtsPocketModelConfig pocket;
} SherpaOnnxOfflineTtsModelConfig;

typedef struct SherpaOnnxOfflineTtsConfig {
  SherpaOnnxOfflineTtsModelConfig model;
  const char *rule_fsts;
  int32_t max_num_sentences;
  const char *rule_fars;
  float silence_scale;
} SherpaOnnxOfflineTtsConfig;

typedef struct SherpaOnnxGeneratedAudio {
  const float *samples;
  int32_t n;
  int32_t sample_rate;
} SherpaOnnxGeneratedAudio;

typedef int32_t (*SherpaOnnxGeneratedAudioProgressCallbackWithArg)(
    const float *samples, int32_t n, float p, void *arg);

typedef struct SherpaOnnxGenerationConfig {
  float silence_scale;
  float speed;
  int32_t sid;
  const float *reference_audio;
  int32_t reference_audio_len;
  int32_t reference_sample_rate;
  const char *reference_text;
  int32_t num_steps;
  const char *extra;
} SherpaOnnxGenerationConfig;

typedef struct SherpaOnnxOfflineTts SherpaOnnxOfflineTts;

const SherpaOnnxOfflineTts *SherpaOnnxCreateOfflineTts(const SherpaOnnxOfflineTtsConfig *config);
void SherpaOnnxDestroyOfflineTts(const SherpaOnnxOfflineTts *tts);

int32_t SherpaOnnxOfflineTtsSampleRate(const SherpaOnnxOfflineTts *tts);
int32_t SherpaOnnxOfflineTtsNumSpeakers(const SherpaOnnxOfflineTts *tts);

const SherpaOnnxGeneratedAudio *SherpaOnnxOfflineTtsGenerateWithConfig(
    const SherpaOnnxOfflineTts *tts, const char *text, const SherpaOnnxGenerationConfig *config,
    SherpaOnnxGeneratedAudioProgressCallbackWithArg callback, void *arg);

void SherpaOnnxDestroyOfflineTtsGeneratedAudio(const SherpaOnnxGeneratedAudio *p);

int32_t SherpaOnnxWriteWave(const float *samples, int32_t n, int32_t sample_rate, const char *filename);

// ============================================================
// Online Automatic Speech Recognition (Streaming STT)
// ============================================================
typedef struct SherpaOnnxFeatureConfig {
  int32_t sample_rate;
  int32_t feature_dim;
} SherpaOnnxFeatureConfig;

typedef struct SherpaOnnxOnlineTransducerModelConfig {
  const char *encoder;
  const char *decoder;
  const char *joiner;
} SherpaOnnxOnlineTransducerModelConfig;

typedef struct SherpaOnnxOnlineModelConfig {
  const char *tokens;
  int32_t num_threads;
  int32_t debug;
  const char *provider;
  const char *model_type;
  const char *modeling_unit;
  const char *bpe_vocab;

  SherpaOnnxOnlineTransducerModelConfig transducer;
} SherpaOnnxOnlineModelConfig;

typedef struct SherpaOnnxEndpointRule {
  int32_t must_contain_nonsilence;
  float min_trailing_silence;
  float min_utterance_length;
} SherpaOnnxEndpointRule;

typedef struct SherpaOnnxEndpointConfig {
  SherpaOnnxEndpointRule rule1;
  SherpaOnnxEndpointRule rule2;
  SherpaOnnxEndpointRule rule3;
} SherpaOnnxEndpointConfig;

typedef struct SherpaOnnxOnlineDecoderConfig {
  const char *decoding_method;
  int32_t num_active_paths;
  int32_t enable_endpoint;
  const char *hotwords_file;
  float hotwords_score;
  const char *rule_fsts;
  float rule_fsts_score;
  float blank_penalty;
} SherpaOnnxOnlineDecoderConfig;

typedef struct SherpaOnnxOnlineRecognizerConfig {
  SherpaOnnxFeatureConfig feat_config;
  SherpaOnnxOnlineModelConfig model_config;
  SherpaOnnxEndpointConfig endpoint_config;
  SherpaOnnxOnlineDecoderConfig decoder_config;
} SherpaOnnxOnlineRecognizerConfig;

typedef struct SherpaOnnxOnlineRecognizer SherpaOnnxOnlineRecognizer;
typedef struct SherpaOnnxOnlineStream SherpaOnnxOnlineStream;

typedef struct SherpaOnnxOnlineRecognizerResult {
  const char *text;
  int32_t count;
  const char **tokens;
  const float *timestamps;
  int32_t segment;
  float start_time;
  float end_time;
} SherpaOnnxOnlineRecognizerResult;

const SherpaOnnxOnlineRecognizer *SherpaOnnxCreateOnlineRecognizer(const SherpaOnnxOnlineRecognizerConfig *config);
void SherpaOnnxDestroyOnlineRecognizer(const SherpaOnnxOnlineRecognizer *recognizer);

SherpaOnnxOnlineStream *SherpaOnnxCreateOnlineStream(const SherpaOnnxOnlineRecognizer *recognizer);
void SherpaOnnxDestroyOnlineStream(SherpaOnnxOnlineStream *stream);

void SherpaOnnxOnlineStreamAcceptWaveform(SherpaOnnxOnlineStream *stream, int32_t sample_rate, const float *samples, int32_t n);
void SherpaOnnxOnlineStreamInputFinished(SherpaOnnxOnlineStream *stream);

int32_t SherpaOnnxIsOnlineStreamReady(const SherpaOnnxOnlineRecognizer *recognizer, const SherpaOnnxOnlineStream *stream);
void SherpaOnnxDecodeOnlineStream(const SherpaOnnxOnlineRecognizer *recognizer, SherpaOnnxOnlineStream *stream);

const SherpaOnnxOnlineRecognizerResult *SherpaOnnxGetOnlineStreamResult(const SherpaOnnxOnlineRecognizer *recognizer, const SherpaOnnxOnlineStream *stream);
void SherpaOnnxDestroyOnlineRecognizerResult(const SherpaOnnxOnlineRecognizerResult *r);

int32_t SherpaOnnxOnlineStreamIsEndpoint(const SherpaOnnxOnlineRecognizer *recognizer, const SherpaOnnxOnlineStream *stream);
void SherpaOnnxOnlineStreamReset(const SherpaOnnxOnlineRecognizer *recognizer, SherpaOnnxOnlineStream *stream);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // HAPPIER_SHERPA_ONNX_C_API_OFFLINE_TTS_H_
