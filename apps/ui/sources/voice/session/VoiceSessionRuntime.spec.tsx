import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

const platformOsMock = vi.hoisted(() => ({ value: 'ios' as 'ios' | 'web' }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      get OS() {
        return platformOsMock.value;
      },
      select: <T,>(options: { web?: T; default?: T; native?: T; ios?: T; android?: T }) =>
        options?.[platformOsMock.value] ?? options?.default ?? options?.native ?? options?.ios ?? options?.android,
    },
  });
});

const defaultUseSetting = (key: string) => {
  if (key === 'voice') return { providerId: 'local_direct' };
  return null;
};

const useSetting = vi.fn(defaultUseSetting);

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useRealtimeStatus: () => 'disconnected',
    useRealtimeMode: () => 'idle',
    useSetting: (key: string) => useSetting(key),
});
});

type Snapshot = {
  adapterId: string | null;
  sessionId: string | null;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  mode: 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';
  canStop: boolean;
};

function createRuntimeAdapter(id: string, initial: Snapshot) {
  let current = initial;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    controller: {
      id,
      start: vi.fn(async ({ sessionId }: { sessionId: string }) => {
        current = {
          adapterId: id,
          sessionId,
          status: 'connecting',
          mode: 'idle',
          canStop: true,
        };
        notify();
      }),
      stop: vi.fn(async () => {}),
      toggle: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      sendContextUpdate: vi.fn(() => {}),
      getSnapshot: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    setSnapshot(next: Snapshot) {
      current = next;
      notify();
    },
    getSnapshot() {
      return current;
    },
  };
}

describe('VoiceSessionRuntime', () => {
  beforeEach(async () => {
    platformOsMock.value = 'ios';
    vi.resetModules();
    useSetting.mockReset();
    useSetting.mockImplementation(defaultUseSetting);

    const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
  });

  afterEach(async () => {
    const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
    useSetting.mockReset();
    useSetting.mockImplementation(defaultUseSetting);
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

    await renderScreen(React.createElement(VoiceSessionRuntime));

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

    await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot().mode).toBe('idle');

    current = { ...current, mode: 'speaking' };
    await act(async () => {
      subscribed?.();
    });

    expect(getVoiceSessionSnapshot().mode).toBe('speaking');
  });

  it('prefers the selected provider adapter snapshot when multiple adapters are active', async () => {
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice') return { providerId: 'local_conversation' };
      return null;
    });

    const snapA: Snapshot = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    };
    const snapB: Snapshot = {
      adapterId: 'local_conversation',
      sessionId: 's2',
      status: 'connected',
      mode: 'speaking',
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
          getSnapshot: () => snapA,
          subscribe: () => () => {},
        },
        {
          id: 'local_conversation',
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

    await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual(snapB);
  });

  it('keeps the active store owner stable when the selected provider changes mid-call', async () => {
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice') return { providerId: 'local_conversation' };
      return null;
    });

    const snapA: Snapshot = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    };
    const snapB: Snapshot = {
      adapterId: 'local_conversation',
      sessionId: 's2',
      status: 'connected',
      mode: 'speaking',
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
          getSnapshot: () => snapA,
          subscribe: () => () => {},
        },
        {
          id: 'local_conversation',
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
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot(snapA);
    await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual(snapA);
  });

  it('stops the current owner and starts the newly selected provider after disconnect', async () => {
    let selectedProviderId = 'local_direct';
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice') return { providerId: selectedProviderId };
      return null;
    });

    const active = createRuntimeAdapter('local_direct', {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });
    const selected = createRuntimeAdapter('local_conversation', {
      adapterId: 'local_conversation',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapters: () => [active.controller, selected.controller],
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot(active.getSnapshot());
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual(active.getSnapshot());

    selectedProviderId = 'local_conversation';
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });

    expect(active.controller.stop).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(selected.controller.start).not.toHaveBeenCalled();
    expect(getVoiceSessionSnapshot()).toEqual(active.getSnapshot());

    await act(async () => {
      active.setSnapshot({
        adapterId: 'local_direct',
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      });
    });

    expect(selected.controller.start).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(getVoiceSessionSnapshot()).toEqual({
      adapterId: 'local_conversation',
      sessionId: 's1',
      status: 'connecting',
      mode: 'idle',
      canStop: true,
    });
  });

  it('stops the current owner and settles to off after a real disconnect snapshot', async () => {
    let selectedProviderId = 'local_direct';
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice') return { providerId: selectedProviderId };
      return null;
    });

    const active = createRuntimeAdapter('local_direct', {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'listening',
      canStop: true,
    });
    const idlePeer = createRuntimeAdapter('local_conversation', {
      adapterId: 'local_conversation',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapters: () => [active.controller, idlePeer.controller],
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot(active.getSnapshot());
    const screen = await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual(active.getSnapshot());

    selectedProviderId = 'off';
    await act(async () => {
      screen.tree.update(React.createElement(VoiceSessionRuntime));
    });

    expect(active.controller.stop).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(idlePeer.controller.start).not.toHaveBeenCalled();
    expect(getVoiceSessionSnapshot()).toEqual(active.getSnapshot());

    await act(async () => {
      active.setSnapshot({
        adapterId: 'local_direct',
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      });
    });

    expect(getVoiceSessionSnapshot()).toEqual({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });

  it('prefers the selected provider adapter snapshot when the provider id is padded', async () => {
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice') return { providerId: ' local_conversation ' };
      return null;
    });

    const snapA: Snapshot = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    };
    const snapB: Snapshot = {
      adapterId: 'local_conversation',
      sessionId: 's2',
      status: 'connected',
      mode: 'speaking',
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
          getSnapshot: () => snapA,
          subscribe: () => () => {},
        },
        {
          id: 'local_conversation',
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

    await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual(snapB);
  });

  it('keeps the stored local provider as the continuous-mode owner on web', async () => {
    platformOsMock.value = 'web';
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice') return { providerId: 'local_conversation' };
      return null;
    });

    const realtimeSnapshot: Snapshot = {
      adapterId: 'realtime_elevenlabs',
      sessionId: 's-rt',
      status: 'connected',
      mode: 'speaking',
      canStop: true,
    };
    const localSnapshot: Snapshot = {
      adapterId: 'local_conversation',
      sessionId: 's-local',
      status: 'connected',
      mode: 'listening',
      canStop: true,
    };

    vi.doMock('@/voice/adapters/registerBuiltinVoiceAdapters', () => ({
      createBuiltinVoiceAdapters: () => [
        {
          id: 'realtime_elevenlabs',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => realtimeSnapshot,
          subscribe: () => () => {},
        },
        {
          id: 'local_conversation',
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          toggle: vi.fn(async () => {}),
          interrupt: vi.fn(async () => {}),
          sendContextUpdate: vi.fn(() => {}),
          getSnapshot: () => localSnapshot,
          subscribe: () => () => {},
        },
      ],
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');

    await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual(localSnapshot);
  });

  it('fails closed when the configured provider id is unsupported', async () => {
    useSetting.mockImplementation((key: string) => {
      if (key === 'voice') return { providerId: 'unsupported_provider' };
      return null;
    });

    const snapA: Snapshot = {
      adapterId: 'adapter_a',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
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
      ],
    }));

    const { VoiceSessionRuntime } = await import('./VoiceSessionRuntime');
    const { getVoiceSessionSnapshot } = await import('./voiceSessionStore');

    await renderScreen(React.createElement(VoiceSessionRuntime));

    expect(getVoiceSessionSnapshot()).toEqual({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });
});
