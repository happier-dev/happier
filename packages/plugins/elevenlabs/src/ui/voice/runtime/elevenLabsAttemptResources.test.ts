import { describe, expect, it, vi } from 'vitest';

import { createElevenLabsAttemptResources } from './elevenLabsAttemptResources.js';

describe('createElevenLabsAttemptResources', () => {
  it('acquires mic, binding, and audio mode in order and releases each exactly once', async () => {
    const order: string[] = [];
    const mic = {
      ensureActive: vi.fn(async () => { order.push('mic'); }),
      teardown: vi.fn(async () => { order.push('mic_teardown'); }),
      setMuted: vi.fn(),
    };
    const resources = createElevenLabsAttemptResources({
      mic,
      transitionToAcquiringMic: () => { order.push('machine'); },
      ensureBound: async () => { order.push('binding'); },
      enableAudioMode: async () => { order.push('audio'); },
      disableAudioMode: async () => { order.push('audio_off'); },
    });

    await resources.port.prepare({
      controlSessionId: 'control-1',
      attemptId: 1,
      request: { requestedTargetSessionId: 'target-1', textOnly: false },
      signal: new AbortController().signal,
    });
    expect(order).toEqual(['machine', 'mic', 'binding', 'audio']);
    await resources.port.release({
      controlSessionId: 'control-1',
      attemptId: 1,
      reason: { code: 'user_stop' },
    });
    expect(order).toEqual(['machine', 'mic', 'binding', 'audio', 'mic_teardown', 'audio_off']);
  });

  it('skips mic acquisition for text-only sessions but still binds and owns audio mode cleanup', async () => {
    const mic = {
      ensureActive: vi.fn(async () => {}),
      teardown: vi.fn(async () => {}),
      setMuted: vi.fn(),
    };
    const ensureBound = vi.fn(async () => {});
    const disableAudioMode = vi.fn(async () => {});
    const resources = createElevenLabsAttemptResources({
      mic,
      transitionToAcquiringMic: vi.fn(),
      ensureBound,
      enableAudioMode: vi.fn(async () => {}),
      disableAudioMode,
    });
    const signal = new AbortController().signal;
    await resources.port.prepare({
      controlSessionId: 'control-text',
      attemptId: 2,
      request: { textOnly: true },
      signal,
    });
    expect(mic.ensureActive).not.toHaveBeenCalled();
    expect(ensureBound).toHaveBeenCalledWith(expect.objectContaining({
      controlSessionId: 'control-text',
      requestedTargetSessionId: null,
    }));
    await resources.port.release({
      controlSessionId: 'control-text',
      attemptId: 2,
      reason: { code: 'aborted' },
    });
    expect(mic.teardown).not.toHaveBeenCalled();
    expect(disableAudioMode).toHaveBeenCalledTimes(1);
  });
});
