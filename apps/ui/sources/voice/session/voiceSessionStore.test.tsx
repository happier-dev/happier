import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('voiceSessionStore', () => {
  it('does not rerender subscribers when setVoiceSessionSnapshot receives an identical snapshot', async () => {
    vi.resetModules();

    const { useVoiceSessionSnapshot } = await import('./voiceSession');
    const { setVoiceSessionSnapshot } = await import('./voiceSessionStore');

    let renders = 0;

    function Test() {
      useVoiceSessionSnapshot();
      renders += 1;
      return React.createElement('div');
    }

    const baseline = {
      adapterId: null,
      sessionId: null,
      status: 'disconnected' as const,
      mode: 'idle' as const,
      canStop: false,
    };

    const snap = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected' as const,
      mode: 'idle' as const,
      canStop: true,
    };

    await act(async () => {
      setVoiceSessionSnapshot(baseline);
    });

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(Test));
    });

    await act(async () => {
      setVoiceSessionSnapshot(snap);
    });
    const afterFirstSet = renders;

    await act(async () => {
      setVoiceSessionSnapshot(snap);
    });

    expect(renders).toBe(afterFirstSet);

    await act(async () => {
      tree.unmount();
    });
  });

  it('clears error fields when the next snapshot omits them', async () => {
    vi.resetModules();

    const { setVoiceSessionSnapshot, getVoiceSessionSnapshot } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot({
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'error',
      mode: 'idle',
      canStop: true,
      errorCode: 'device_stt_start_failed',
      errorMessage: 'device_stt_start_failed',
    });

    setVoiceSessionSnapshot({
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const snap = getVoiceSessionSnapshot();
    expect(snap.errorCode).toBeUndefined();
    expect(snap.errorMessage).toBeUndefined();
  });
});

