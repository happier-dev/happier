import { afterEach, describe, expect, it } from 'vitest';

import { resolveVoiceInferenceRuntimeIsolationMode } from '../voiceInferenceWorkerConfig';

describe('voice inference runtime isolation mode flag', () => {
  const previous = process.env.HAPPIER_VOICE_INFERENCE_ISOLATION;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.HAPPIER_VOICE_INFERENCE_ISOLATION;
    } else {
      process.env.HAPPIER_VOICE_INFERENCE_ISOLATION = previous;
    }
  });

  it('defaults to the supervised forked path when unset', () => {
    delete process.env.HAPPIER_VOICE_INFERENCE_ISOLATION;
    expect(resolveVoiceInferenceRuntimeIsolationMode()).toBe('forked');
  });

  it('keeps the forked default for unrecognized values (fail-safe)', () => {
    process.env.HAPPIER_VOICE_INFERENCE_ISOLATION = 'nonsense';
    expect(resolveVoiceInferenceRuntimeIsolationMode()).toBe('forked');
  });

  it.each(['forked', 'worker', 'process', 'FORKED'])('selects the forked worker for %s', (value) => {
    process.env.HAPPIER_VOICE_INFERENCE_ISOLATION = value;
    expect(resolveVoiceInferenceRuntimeIsolationMode()).toBe('forked');
  });

  it.each(['in_process', 'IN_PROCESS'])('allows the explicit diagnostic/test in-process override for %s', (value) => {
    process.env.HAPPIER_VOICE_INFERENCE_ISOLATION = value;
    expect(resolveVoiceInferenceRuntimeIsolationMode()).toBe('in_process');
  });
});
