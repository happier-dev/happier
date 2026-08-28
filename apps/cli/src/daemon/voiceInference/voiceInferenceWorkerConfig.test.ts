import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_BYTES_BOUNDS } from '@happier-dev/protocol';

import {
  VOICE_INFERENCE_WORKER_IPC_DEFAULTS,
  VOICE_INFERENCE_WORKER_MAX_FRAME_BYTES_BOUNDS,
  VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS_BOUNDS,
  resolveVoiceInferenceMaxLoadedArtifactBytes,
  resolveVoiceInferenceWorkerMaxFrameBytes,
  resolveVoiceInferenceWorkerRequestTimeoutMs,
} from './voiceInferenceWorkerConfig';

const ENV_KEY = 'HAPPIER_VOICE_INFERENCE_MAX_LOADED_ARTIFACT_BYTES';

function withEnv(key: string, value: string | undefined, run: () => void): void {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

describe('resolveVoiceInferenceMaxLoadedArtifactBytes', () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previous;
    }
  });

  it('defaults to 0 (declared loaded-artifact budget disabled) when the env override is absent', () => {
    expect(resolveVoiceInferenceMaxLoadedArtifactBytes()).toBe(0);
  });

  it('accepts an in-bounds override', () => {
    const value = VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_BYTES_BOUNDS.min + 1024;
    process.env[ENV_KEY] = String(value);
    expect(resolveVoiceInferenceMaxLoadedArtifactBytes()).toBe(value);
  });

  it('clamps an over-max override to the bound ceiling', () => {
    process.env[ENV_KEY] = String(VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_BYTES_BOUNDS.max * 4);
    expect(resolveVoiceInferenceMaxLoadedArtifactBytes()).toBe(VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_BYTES_BOUNDS.max);
  });

  it('falls back to disabled (0) for a below-min override', () => {
    process.env[ENV_KEY] = String(VOICE_RUNTIME_LOADED_ARTIFACT_BUDGET_BYTES_BOUNDS.min - 1);
    expect(resolveVoiceInferenceMaxLoadedArtifactBytes()).toBe(0);
  });
});

describe('forked worker IPC safety knobs', () => {
  const REQUEST_TIMEOUT_KEY = 'HAPPIER_VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS';
  const MAX_FRAME_KEY = 'HAPPIER_VOICE_INFERENCE_WORKER_MAX_FRAME_BYTES';

  it('defaults each knob to the centralized IPC defaults', () => {
    expect(VOICE_INFERENCE_WORKER_IPC_DEFAULTS).toMatchObject({
      requestTimeoutMs: 30_000,
      warmPrimeRequestTimeoutMs: 600_000,
    });
    withEnv(REQUEST_TIMEOUT_KEY, undefined, () => {
      expect(resolveVoiceInferenceWorkerRequestTimeoutMs()).toBe(
        VOICE_INFERENCE_WORKER_IPC_DEFAULTS.requestTimeoutMs,
      );
    });
    withEnv(MAX_FRAME_KEY, undefined, () => {
      expect(resolveVoiceInferenceWorkerMaxFrameBytes()).toBe(
        VOICE_INFERENCE_WORKER_IPC_DEFAULTS.maxFrameBytes,
      );
    });
  });

  it('accepts in-bounds overrides for every knob', () => {
    withEnv(REQUEST_TIMEOUT_KEY, String(VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS_BOUNDS.min + 1_000), () => {
      expect(resolveVoiceInferenceWorkerRequestTimeoutMs()).toBe(
        VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS_BOUNDS.min + 1_000,
      );
    });
    withEnv(MAX_FRAME_KEY, String(VOICE_INFERENCE_WORKER_MAX_FRAME_BYTES_BOUNDS.min + 1_024), () => {
      expect(resolveVoiceInferenceWorkerMaxFrameBytes()).toBe(
        VOICE_INFERENCE_WORKER_MAX_FRAME_BYTES_BOUNDS.min + 1_024,
      );
    });
  });

  it('clamps over-max overrides to each ceiling', () => {
    withEnv(REQUEST_TIMEOUT_KEY, String(VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS_BOUNDS.max * 4), () => {
      expect(resolveVoiceInferenceWorkerRequestTimeoutMs()).toBe(
        VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS_BOUNDS.max,
      );
    });
    withEnv(MAX_FRAME_KEY, String(VOICE_INFERENCE_WORKER_MAX_FRAME_BYTES_BOUNDS.max * 4), () => {
      expect(resolveVoiceInferenceWorkerMaxFrameBytes()).toBe(
        VOICE_INFERENCE_WORKER_MAX_FRAME_BYTES_BOUNDS.max,
      );
    });
  });

  it('falls back to defaults for below-min or malformed overrides', () => {
    withEnv(REQUEST_TIMEOUT_KEY, 'not-a-number', () => {
      expect(resolveVoiceInferenceWorkerRequestTimeoutMs()).toBe(
        VOICE_INFERENCE_WORKER_IPC_DEFAULTS.requestTimeoutMs,
      );
    });
    withEnv(MAX_FRAME_KEY, String(VOICE_INFERENCE_WORKER_MAX_FRAME_BYTES_BOUNDS.min - 1), () => {
      expect(resolveVoiceInferenceWorkerMaxFrameBytes()).toBe(
        VOICE_INFERENCE_WORKER_IPC_DEFAULTS.maxFrameBytes,
      );
    });
  });

  it('keeps the per-frame ceiling well below the old 64 MiB bound (M2)', () => {
    expect(VOICE_INFERENCE_WORKER_IPC_DEFAULTS.maxFrameBytes).toBeLessThan(64 * 1024 * 1024);
  });
});
