import { describe, expect, it } from 'vitest';

import {
  VOICE_RUNTIME_TTS_DEFAULTS,
  VOICE_RUNTIME_TTS_LATENCY_BUDGET_BOUNDS,
  VOICE_RUNTIME_TTS_LATENCY_DEMOTION_THRESHOLD_BOUNDS,
  VOICE_RUNTIME_WARM_DEFAULTS,
  VOICE_RUNTIME_WARM_IDLE_RESIDENCY_BOUNDS,
  VOICE_RUNTIME_PER_MODEL_CONCURRENCY_BOUNDS,
  VOICE_RUNTIME_STT_DEFAULTS,
  VOICE_RUNTIME_STT_MAX_UPLOAD_BYTES_BOUNDS,
  VOICE_RUNTIME_ACCEPTED_STT_INPUT_FORMATS,
  VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT,
  VOICE_RUNTIME_STT_PCM_FORMAT,
  VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_DEFAULTS,
  VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_BYTES_BOUNDS,
} from './runtimeConfig.js';

describe('voice runtime config defaults', () => {
  it('captures the canonical TTS defaults', () => {
    expect(VOICE_RUNTIME_TTS_DEFAULTS.defaultCodec).toEqual({ codec: 'wav', mimeType: 'audio/wav' });
    expect(VOICE_RUNTIME_TTS_DEFAULTS.latencyBudgetMs).toBe(2_000);
    expect(VOICE_RUNTIME_TTS_DEFAULTS.consecutiveSlowCallsBeforeDemotion).toBe(2);
  });

  it('captures the canonical warm/concurrency defaults', () => {
    expect(VOICE_RUNTIME_WARM_DEFAULTS.warmIdleEvictMs).toBe(5 * 60 * 1000);
    expect(VOICE_RUNTIME_WARM_DEFAULTS.warmOnVoiceHomeAttach).toBe(true);
    expect(VOICE_RUNTIME_WARM_DEFAULTS.perModelConcurrency).toBe(1);
    expect(VOICE_RUNTIME_WARM_DEFAULTS.warmRequestTimeoutMs).toBe(10 * 60 * 1000);
  });

  it('captures the canonical STT defaults', () => {
    expect(VOICE_RUNTIME_STT_DEFAULTS.maxUploadBytes).toBe(25 * 1024 * 1024);
    expect(VOICE_RUNTIME_ACCEPTED_STT_INPUT_FORMATS).toContain('audio/wav');
    expect(VOICE_RUNTIME_ACCEPTED_STT_INPUT_FORMATS).toContain('audio/3gpp');
  });
});

describe('voice runtime config bounds', () => {
  it('captures the latency budget bounds', () => {
    expect(VOICE_RUNTIME_TTS_LATENCY_BUDGET_BOUNDS).toEqual({ min: 250, max: 60_000 });
  });

  it('captures the demotion threshold bounds', () => {
    expect(VOICE_RUNTIME_TTS_LATENCY_DEMOTION_THRESHOLD_BOUNDS).toEqual({ min: 1, max: 10 });
  });

  it('captures the idle residency bounds', () => {
    expect(VOICE_RUNTIME_WARM_IDLE_RESIDENCY_BOUNDS).toEqual({ min: 1_000, max: 60 * 60 * 1000 });
  });

  it('captures the per-model concurrency bounds', () => {
    expect(VOICE_RUNTIME_PER_MODEL_CONCURRENCY_BOUNDS).toEqual({ min: 1, max: 64 });
  });

  it('captures the STT max upload bounds', () => {
    expect(VOICE_RUNTIME_STT_MAX_UPLOAD_BYTES_BOUNDS).toEqual({ min: 1, max: 1024 * 1024 * 1024 });
  });

  it('captures the declared loaded-artifact budget bounds', () => {
    expect(VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_BYTES_BOUNDS.min).toBeGreaterThan(0);
    expect(VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_BYTES_BOUNDS.max).toBeGreaterThan(VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_BYTES_BOUNDS.min);
  });
});

describe('canonical STT PCM format', () => {
  it('is 16 kHz mono signed 16-bit little-endian PCM', () => {
    expect(VOICE_RUNTIME_STT_PCM_FORMAT).toEqual({
      sampleRateHz: 16_000,
      channelCount: 1,
      bitsPerSample: 16,
      ffmpegCodec: 'pcm_s16le',
    });
  });

  it('exposes the daemon format as an identity alias of the canonical const (single source of truth)', () => {
    expect(VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT).toBe(VOICE_RUNTIME_STT_PCM_FORMAT);
  });
});

describe('voice runtime loaded-artifact budget defaults', () => {
  it('disables the declared loaded-artifact budget by default (0 = unbounded)', () => {
    expect(VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_DEFAULTS.maxLoadedArtifactBytes).toBe(0);
  });
});
