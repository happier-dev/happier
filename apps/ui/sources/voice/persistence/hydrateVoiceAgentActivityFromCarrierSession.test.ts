import { beforeEach, describe, expect, it, vi } from 'vitest';

const onSessionVisible = vi.fn();
const stopVoiceAgent = vi.fn(async (_sessionId: string) => {});
const clearVoiceAgentRunMetadataFromSession = vi.fn(async (_input: { sessionId: string }) => {});

const state: any = {
  sessions: {},
  settings: {
    voice: {
      adapters: {
        local_conversation: {
          networkTimeoutMs: 250,
          agent: { transcript: { persistenceMode: 'persistent', epoch: 3 } },
        },
      },
    },
  },
  sessionMessages: {},
  applySettingsLocal: (patch: any) => {
    const nextTranscript = patch?.voice?.adapters?.local_conversation?.agent?.transcript;
    if (nextTranscript && typeof nextTranscript === 'object') {
      state.settings.voice.adapters.local_conversation.agent.transcript = {
        ...(state.settings.voice.adapters.local_conversation.agent.transcript ?? {}),
        ...nextTranscript,
      };
    }
  },
};

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: () => state,
  },
});
});

vi.mock('@/sync/sync', () => ({
  sync: {
    onSessionVisible: (sessionId: string) => onSessionVisible(sessionId),
  },
}));

vi.mock('@/voice/agent/voiceAgentSessions', () => ({
  voiceAgentSessions: {
    stop: (sessionId: string) => stopVoiceAgent(sessionId),
  },
}));

vi.mock('@/voice/persistence/voiceAgentRunMetadata', () => ({
  clearVoiceAgentRunMetadataFromSession: (input: { sessionId: string }) => clearVoiceAgentRunMetadataFromSession(input),
}));

describe('hydrateVoiceAgentActivityFromCarrierSession', () => {
  beforeEach(async () => {
    vi.resetModules();
    onSessionVisible.mockReset();
    stopVoiceAgent.mockReset();
    clearVoiceAgentRunMetadataFromSession.mockReset();

    state.sessions = {};
    state.sessionMessages = {};
    state.settings.voice.adapters.local_conversation.networkTimeoutMs = 250;
    state.settings.voice.adapters.local_conversation.agent.transcript = { persistenceMode: 'persistent', epoch: 3 };

    const { useVoiceActivityStore } = await import('@/voice/activity/voiceActivityStore');
    useVoiceActivityStore.setState((s) => ({ ...s, eventsBySessionId: {} }));
  });

  it('replaces agent activity events from carrier transcript messages tagged with voice_agent_turn.v1 for the active epoch', async () => {
    state.sessions = {
      sys_voice: { id: 'sys_voice', updatedAt: 10, metadata: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } } },
    };

    state.sessionMessages.sys_voice = {
      isLoaded: true,
      messages: [
        {
          kind: 'agent-text',
          id: 'm2',
          localId: null,
          createdAt: 200,
          text: 'ASSIST',
          meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'assistant', voiceAgentId: 'mid', ts: 200 } } },
        },
        {
          kind: 'user-text',
          id: 'm1',
          localId: null,
          createdAt: 100,
          text: 'USER',
          meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'mid', ts: 100 } } },
        },
        {
          kind: 'user-text',
          id: 'm_old',
          localId: null,
          createdAt: 50,
          text: 'OLD',
          meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 2, role: 'user', voiceAgentId: 'mid', ts: 50 } } },
        },
      ],
    };

    const { hydrateVoiceAgentActivityFromCarrierSession } = await import('./hydrateVoiceAgentActivityFromCarrierSession');
    await hydrateVoiceAgentActivityFromCarrierSession();

    const { useVoiceActivityStore } = await import('@/voice/activity/voiceActivityStore');
    const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
    const events = useVoiceActivityStore.getState().eventsBySessionId[VOICE_AGENT_GLOBAL_SESSION_ID] ?? [];
    expect(events.map((e: any) => ({ id: e.id, kind: e.kind, text: e.text, ts: e.ts }))).toEqual([
      { id: 'm1', kind: 'user.text', text: 'USER', ts: 100 },
      { id: 'm2', kind: 'assistant.text', text: 'ASSIST', ts: 200 },
    ]);
  });

  it('fetches carrier transcript when not yet loaded, then hydrates once loaded', async () => {
    state.sessions = {
      sys_voice: { id: 'sys_voice', updatedAt: 10, metadata: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } } },
    };

    state.sessionMessages.sys_voice = { isLoaded: false, messages: [] };
    onSessionVisible.mockImplementation((_sid: string) => {
      // Simulate async load on next tick.
      setTimeout(() => {
        state.sessionMessages.sys_voice = {
          isLoaded: true,
          messages: [
            {
              kind: 'user-text',
              id: 'm1',
              localId: null,
              createdAt: 100,
              text: 'USER',
              meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'mid', ts: 100 } } },
            },
          ],
        };
      }, 0);
    });

    const { hydrateVoiceAgentActivityFromCarrierSession } = await import('./hydrateVoiceAgentActivityFromCarrierSession');
    await hydrateVoiceAgentActivityFromCarrierSession();

    expect(onSessionVisible).toHaveBeenCalledWith('sys_voice');
    const { useVoiceActivityStore } = await import('@/voice/activity/voiceActivityStore');
    const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
    const events = useVoiceActivityStore.getState().eventsBySessionId[VOICE_AGENT_GLOBAL_SESSION_ID] ?? [];
    expect(events).toHaveLength(1);
    expect((events[0] as any).kind).toBe('user.text');
  });

  it('keeps existing voice activity when the carrier transcript does not finish loading', async () => {
    state.settings.voice.adapters.local_conversation.networkTimeoutMs = 25;
    state.sessions = {
      sys_voice: { id: 'sys_voice', updatedAt: 10, metadata: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } } },
    };
    state.sessionMessages.sys_voice = { isLoaded: false, messages: [] };

    const { useVoiceActivityStore } = await import('@/voice/activity/voiceActivityStore');
    const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
    useVoiceActivityStore.getState().replaceSessionEvents(VOICE_AGENT_GLOBAL_SESSION_ID, [
      { id: 'existing', ts: 1, sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, adapterId: 'local_conversation', kind: 'assistant.text', text: 'Keep me' } as any,
    ]);

    const { hydrateVoiceAgentActivityFromCarrierSession } = await import('./hydrateVoiceAgentActivityFromCarrierSession');
    await hydrateVoiceAgentActivityFromCarrierSession();

    const events = useVoiceActivityStore.getState().eventsBySessionId[VOICE_AGENT_GLOBAL_SESSION_ID] ?? [];
    expect(onSessionVisible).toHaveBeenCalledWith('sys_voice');
    expect(events.map((event: any) => event.id)).toEqual(['existing']);
  });

  it('does not rehydrate carrier transcript events from the previous epoch after reset', async () => {
    state.sessions = {
      sys_voice: {
        id: 'sys_voice',
        updatedAt: 10,
        metadata: {
          systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
          voiceAgentRunV1: { v: 1, runId: 'run_prev', backendId: 'claude', resumeHandle: null, updatedAtMs: 1 },
        },
      },
    };
    state.sessionMessages.sys_voice = {
      isLoaded: true,
      messages: [
        {
          kind: 'user-text',
          id: 'm1',
          localId: null,
          createdAt: 100,
          text: 'USER',
          meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'mid', ts: 100 } } },
        },
      ],
    };

    const { resetGlobalVoiceAgentPersistence } = await import('@/voice/agent/resetGlobalVoiceAgentPersistence');
    const { hydrateVoiceAgentActivityFromCarrierSession } = await import('./hydrateVoiceAgentActivityFromCarrierSession');
    const { useVoiceActivityStore } = await import('@/voice/activity/voiceActivityStore');
    const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');

    await resetGlobalVoiceAgentPersistence();
    await hydrateVoiceAgentActivityFromCarrierSession();

    expect(stopVoiceAgent).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
    expect(clearVoiceAgentRunMetadataFromSession).toHaveBeenCalledWith({ sessionId: 'sys_voice' });
    expect(state.settings.voice.adapters.local_conversation.agent.transcript.epoch).toBe(4);
    expect(useVoiceActivityStore.getState().eventsBySessionId[VOICE_AGENT_GLOBAL_SESSION_ID] ?? []).toEqual([]);
  });
});
