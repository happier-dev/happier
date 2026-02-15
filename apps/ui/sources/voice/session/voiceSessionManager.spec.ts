import { beforeEach, describe, expect, it } from 'vitest';

import type { VoiceAdapterController, VoiceAdapterId, VoiceSessionSnapshot } from './types';
import { createVoiceSessionManager } from './voiceSessionManager';
import { setVoiceSessionSnapshot } from './voiceSessionStore';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function makeAdapter(id: VoiceAdapterId, opts?: { initial?: Partial<VoiceSessionSnapshot> }) {
  let started = false;
  let lastSessionId: string | null = null;
  const snapshot: Mutable<VoiceSessionSnapshot> = {
    adapterId: id,
    sessionId: null,
    status: 'disconnected',
    mode: 'idle',
    canStop: false,
    ...(opts?.initial ?? {}),
  };

  const controller: VoiceAdapterController = {
    id,
    getSnapshot: () => ({ ...snapshot }),
    start: async ({ sessionId }) => {
      started = true;
      lastSessionId = sessionId;
      snapshot.sessionId = sessionId;
      snapshot.status = 'connected';
      snapshot.mode = 'listening';
      snapshot.canStop = true;
    },
    stop: async ({ sessionId }) => {
      if (snapshot.sessionId !== sessionId) return;
      snapshot.sessionId = null;
      snapshot.status = 'disconnected';
      snapshot.mode = 'idle';
      snapshot.canStop = false;
    },
    toggle: async ({ sessionId }) => {
      if (snapshot.status === 'connected') {
        await controller.stop({ sessionId });
        return;
      }
      await controller.start({ sessionId });
    },
    interrupt: async () => {},
    sendContextUpdate: () => {},
  };

  return {
    controller,
    get started() {
      return started;
    },
    get lastSessionId() {
      return lastSessionId;
    },
  };
}

describe('voiceSessionManager (core)', () => {
  beforeEach(() => {
    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });

  it('starts the active adapter when toggled from disconnected', async () => {
    const a = makeAdapter('test_adapter' as VoiceAdapterId);
    const mgr = createVoiceSessionManager({
      resolveActiveAdapterId: () => a.controller.id,
      getAdapter: (id) => (id === a.controller.id ? a.controller : null),
    });

    expect(mgr.getSnapshot().status).toBe('disconnected');

    await mgr.toggle('s1');

    const snap = mgr.getSnapshot();
    expect(a.started).toBe(true);
    expect(a.lastSessionId).toBe('s1');
    expect(snap.status).toBe('connected');
    expect(snap.mode).toBe('listening');
    expect(snap.adapterId).toBe(a.controller.id);
    expect(snap.sessionId).toBe('s1');
    expect(snap.canStop).toBe(true);
  });

  it('stops the active adapter when toggled from connected', async () => {
    const a = makeAdapter('test_adapter' as VoiceAdapterId);
    const mgr = createVoiceSessionManager({
      resolveActiveAdapterId: () => a.controller.id,
      getAdapter: (id) => (id === a.controller.id ? a.controller : null),
    });

    await mgr.toggle('s1');
    expect(mgr.getSnapshot().status).toBe('connected');

    await mgr.toggle('s1');

    const snap = mgr.getSnapshot();
    expect(snap.status).toBe('disconnected');
    expect(snap.mode).toBe('idle');
    expect(snap.sessionId).toBe(null);
    expect(snap.canStop).toBe(false);
  });

  it('is a no-op when adapter id resolves to off', async () => {
    const a = makeAdapter('test_adapter' as VoiceAdapterId);
    const mgr = createVoiceSessionManager({
      resolveActiveAdapterId: () => 'off',
      getAdapter: (_id) => a.controller,
    });

    await mgr.toggle('s1');
    expect(mgr.getSnapshot().status).toBe('disconnected');
    expect(a.started).toBe(false);
  });

  it('stops the active adapter when toggled but the adapter id resolves to off', async () => {
    const a = makeAdapter('test_adapter' as VoiceAdapterId);
    await a.controller.start({ sessionId: 's1' });
    setVoiceSessionSnapshot(a.controller.getSnapshot());

    const mgr = createVoiceSessionManager({
      resolveActiveAdapterId: () => 'off',
      getAdapter: (id) => (id === a.controller.id ? a.controller : null),
    });

    expect(mgr.getSnapshot().status).toBe('connected');
    await mgr.toggle('s1');
    expect(mgr.getSnapshot().status).toBe('disconnected');
  });
});
