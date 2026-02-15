import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useSetting = vi.fn((key: string) => {
  if (key === 'voice') return { providerId: 'local_direct' };
  return null;
});

vi.mock('@/sync/domains/state/storage', () => ({
  useRealtimeStatus: () => 'disconnected',
  useRealtimeMode: () => 'idle',
  useSetting: (key: string) => useSetting(key),
}));

vi.mock('@/voice/local/localVoiceEngine', () => ({
  useLocalVoiceStatus: () => 'idle',
  getLocalVoiceState: () => ({ status: 'idle', sessionId: null, error: null }),
}));

type Snapshot = {
  adapterId: string | null;
  sessionId: string | null;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  mode: 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';
  canStop: boolean;
};

describe('VoiceSessionRuntime', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('publishes the active adapter snapshot into the voice session store', async () => {
    const snap: Snapshot = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    };

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapters: () => [
        {
          id: 'local_direct',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => snap,
          subscribe: (listener: () => void) => {
            // no-op; test only asserts initial publish
            void listener;
            return () => {};
          },
        },
      ],
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    await act(async () => {
      renderer.create(React.createElement(VoiceSessionRuntime));
    });

    expect(getVoiceSessionSnapshot()).toEqual(snap);
  });

  it('updates the store when an adapter subscription fires', async () => {
    let current: Snapshot = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    };

    let subscribed: (() => void) | null = null;

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapters: () => [
        {
          id: 'local_direct',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => current,
          subscribe: (listener: () => void) => {
            subscribed = listener;
            return () => {
              subscribed = null;
            };
          },
        },
      ],
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');

    await act(async () => {
      renderer.create(React.createElement(VoiceSessionRuntime));
    });

    expect(getVoiceSessionSnapshot().mode).toBe('idle');

    current = { ...current, mode: 'speaking' };
    await act(async () => {
      subscribed?.();
    });

    expect(getVoiceSessionSnapshot().mode).toBe('speaking');
  });

  it('prefers the selected provider adapter snapshot when multiple adapters are active', async () => {
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice') return { providerId: 'adapter_b' };
      return null;
    });

    const snapA: Snapshot = {
      adapterId: 'adapter_a',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    };
    const snapB: Snapshot = {
      adapterId: 'adapter_b',
      sessionId: 's2',
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    };

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapters: () => [
        {
          id: 'adapter_a',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => snapA,
          subscribe: () => () => {},
        },
        {
          id: 'adapter_b',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => snapB,
          subscribe: () => () => {},
        },
      ],
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');

    await act(async () => {
      renderer.create(React.createElement(VoiceSessionRuntime));
    });

    expect(getVoiceSessionSnapshot()).toEqual(snapB);
  });
});
