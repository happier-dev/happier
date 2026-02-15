import { beforeEach, describe, expect, it, vi } from 'vitest';

const onSessionVisible = vi.fn();

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
};

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => state,
  },
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    onSessionVisible: (sessionId: string) => onSessionVisible(sessionId),
  },
}));

describe('hydrateVoiceAgentActivityFromCarrierSession', () => {
  beforeEach(async () => {
    vi.resetModules();
    onSessionVisible.mockReset();

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
});
