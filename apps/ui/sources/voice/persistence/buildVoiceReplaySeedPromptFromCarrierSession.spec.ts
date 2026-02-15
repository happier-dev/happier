import { beforeEach, describe, expect, it, vi } from 'vitest';

const onSessionVisible = vi.fn();

const state: any = {
  sessions: {
    sys_voice: { id: 'sys_voice', updatedAt: 10, metadata: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } } },
  },
  settings: {},
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

describe('buildVoiceReplaySeedPromptFromCarrierSession', () => {
  beforeEach(() => {
    vi.resetModules();
    onSessionVisible.mockReset();
    state.sessionMessages = {};
  });

  it('builds a canonical replay seed prompt from voice_agent_turn.v1 transcript items (epoch-filtered)', async () => {
    state.sessionMessages.sys_voice = {
      isLoaded: true,
      messages: [
        {
          kind: 'user-text',
          id: 'm_old',
          localId: null,
          createdAt: 1,
          text: 'OLD',
          meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 2, role: 'user', voiceAgentId: 'mid', ts: 1 } } },
        },
        {
          kind: 'user-text',
          id: 'm1',
          localId: null,
          createdAt: 10,
          text: 'U1',
          meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'mid', ts: 10 } } },
        },
        {
          kind: 'agent-text',
          id: 'm2',
          localId: null,
          createdAt: 20,
          text: 'A1',
          meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'assistant', voiceAgentId: 'mid', ts: 20 } } },
        },
        {
          kind: 'user-text',
          id: 'm3',
          localId: null,
          createdAt: 30,
          text: 'U2',
          meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'mid', ts: 30 } } },
        },
      ],
    };

    const { buildVoiceReplaySeedPromptFromCarrierSession } = await import('./buildVoiceReplaySeedPromptFromCarrierSession');
    const prompt = await buildVoiceReplaySeedPromptFromCarrierSession({
      carrierSessionId: 'sys_voice',
      epoch: 3,
      strategy: 'recent_messages',
      recentMessagesCount: 2,
    });

    expect(prompt).toContain('Recent transcript:');
    expect(prompt).toContain('Assistant: A1');
    expect(prompt).toContain('User: U2');
    expect(prompt).not.toContain('OLD');
    expect(prompt).not.toContain('User: U1');
  });
});

