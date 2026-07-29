import { describe, expect, it, vi } from 'vitest';

import { stopVoiceQaMediaSession } from './stopVoiceQaMediaSession';

describe('stopVoiceQaMediaSession', () => {
  it('finishes a local capture turn before stopping the owning Voice session', async () => {
    const toggleLocalTurn = vi.fn(async () => {});
    const stopSession = vi.fn(async () => {});

    await stopVoiceQaMediaSession({
      sessionId: 'session-local',
      snapshot: { adapterId: 'local_conversation' },
      getSnapshot: () => ({
        adapterId: 'local_conversation',
        sessionId: 'session-local',
        status: 'connected',
        mode: 'idle',
        canStop: true,
      }),
      resolveEngineKind: () => 'local',
      toggleLocalTurn,
      stopSession,
    });

    expect(toggleLocalTurn).toHaveBeenCalledWith('session-local');
    expect(stopSession).toHaveBeenCalledWith('session-local');
    expect(toggleLocalTurn.mock.invocationCallOrder[0]).toBeLessThan(
      stopSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('fails visibly when the local turn owner leaves the same capture listening', async () => {
    await expect(stopVoiceQaMediaSession({
      sessionId: 'session-local',
      snapshot: { adapterId: 'local_conversation' },
      getSnapshot: () => ({
        adapterId: 'local_conversation',
        sessionId: 'session-local',
        status: 'connected',
        mode: 'listening',
        canStop: true,
      }),
      resolveEngineKind: () => 'local',
      toggleLocalTurn: async () => {},
      stopSession: async () => {},
    })).rejects.toThrow('voice_qa_media_stop_unsettled');
  });

  it('surfaces the canonical local runtime failure after capture stop', async () => {
    await expect(stopVoiceQaMediaSession({
      sessionId: 'session-local',
      snapshot: { adapterId: 'local_conversation' },
      getSnapshot: () => ({
        adapterId: 'local_conversation',
        sessionId: 'session-local',
        status: 'error',
        mode: 'idle',
        canStop: false,
        errorCode: 'provider_error',
        errorMessage: 'recording_uri_missing',
      }),
      resolveEngineKind: () => 'local',
      toggleLocalTurn: async () => {},
      stopSession: async () => {},
    })).rejects.toThrow('voice_qa_media_stop_failed:recording_uri_missing');
  });

  it('stops non-local media sessions through the canonical session manager', async () => {
    const toggleLocalTurn = vi.fn(async () => {});
    const stopSession = vi.fn(async () => {});

    await stopVoiceQaMediaSession({
      sessionId: 'session-realtime',
      snapshot: { adapterId: 'realtime_elevenlabs' },
      getSnapshot: () => ({
        adapterId: null,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      }),
      resolveEngineKind: () => 'realtime',
      toggleLocalTurn,
      stopSession,
    });

    expect(stopSession).toHaveBeenCalledWith('session-realtime');
    expect(toggleLocalTurn).not.toHaveBeenCalled();
  });
});
