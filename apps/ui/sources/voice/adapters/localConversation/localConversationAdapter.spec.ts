import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

const toggleLocalVoiceTurn = vi.fn(async () => {});
const stopLocalVoiceSession = vi.fn(async () => {});
const abortLocalVoiceTurn = vi.fn(async (_sessionId: string) => {});
const appendLocalVoiceAgentContextUpdate = vi.fn();
const sendVoiceTextTurn = vi.fn(async () => {});
const getLocalVoiceState = vi.fn(() => ({
  status: 'idle' as const,
  sessionId: null as string | null,
  error: null as Error | null,
}));

const ensureBound = vi.fn(async (_params: any) => null);
const voiceAgentSessions = { sendTurn: vi.fn(), stop: vi.fn(), isActive: vi.fn(), appendContextUpdate: vi.fn() };

const state: any = {
  settings: {
    voice: {
      providerId: 'local_conversation',
      adapters: {
        local_conversation: { conversationMode: 'agent', agent: { backend: 'openai_compat' } },
      },
    },
  },
};

function resetMockVoiceSettings(): void {
  state.settings.voice.providerId = 'local_conversation';
  state.settings.voice.adapters.local_conversation = {
    conversationMode: 'agent',
    agent: { backend: 'openai_compat' },
  };
}

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: { getState: () => state },
});
});

vi.mock('@/voice/local/localVoiceEngine', () => ({
  toggleLocalVoiceTurn,
  stopLocalVoiceSession,
  abortLocalVoiceTurn,
  appendLocalVoiceAgentContextUpdate,
  getLocalVoiceState,
}));
vi.mock('@/voice/local/sendVoiceTextTurn', () => ({
  sendVoiceTextTurn,
}));
vi.mock('@/voice/agent/voiceAgentSessions', () => ({
  voiceAgentSessions,
}));
vi.mock('@/voice/sessionBinding/voiceSessionBindingRuntime', () => ({
  voiceSessionBindingManager: {
    ensureBound: (params: any) => ensureBound(params),
  },
}));

describe('local conversation voice adapter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    resetMockVoiceSettings();
    getLocalVoiceState.mockReturnValue({
      status: 'idle',
      sessionId: null,
      error: null,
    });
  });

  afterAll(() => {
    vi.resetModules();
  });

  it('delegates toggle to local voice engine', async () => {
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.toggle({ sessionId: 's1' });
    expect(toggleLocalVoiceTurn).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
  });

  it('binds the requested target session through the voice session binding manager when starting from a session in agent mode', async () => {
    ensureBound.mockClear();
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.toggle({ sessionId: 's1' });
    expect(ensureBound).toHaveBeenCalledWith({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      requestedTargetSessionId: 's1',
    });
  });

  it('binds the global hidden voice conversation session when starting from the sidebar in agent mode', async () => {
    ensureBound.mockClear();
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.toggle({ sessionId: '' });
    expect(ensureBound).toHaveBeenCalledWith({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      requestedTargetSessionId: null,
    });
  });

  it('sends context updates to the local agent buffer', async () => {
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    adapter.sendContextUpdate({ sessionId: 's1', update: 'context' });
    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID, 'context');
  });

  it('treats idle local voice state with a sessionId as connected (ready)', async () => {
    getLocalVoiceState.mockReturnValueOnce({ status: 'idle', sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, error: null });
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    expect(adapter.getSnapshot()).toMatchObject({
      status: 'connected',
      mode: 'idle',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      canStop: true,
    });
  });

  it('interrupt aborts the current turn without hanging up the local voice session', async () => {
    abortLocalVoiceTurn.mockClear();
    stopLocalVoiceSession.mockClear();
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.interrupt({ sessionId: 's1' });

    expect(abortLocalVoiceTurn).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
    expect(stopLocalVoiceSession).not.toHaveBeenCalled();
  });

  it('routes typed sends through the local voice text turn path for synthetic agent sessions', async () => {
    sendVoiceTextTurn.mockClear();
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.sendTextTurn?.({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-home',
      text: 'hello from composer',
    });

    expect(sendVoiceTextTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        userText: 'hello from composer',
        voiceAgentSessions,
      }),
    );
  });

  it('routes typed sends through the local voice text turn path for daemon-backed agent sessions too', async () => {
    sendVoiceTextTurn.mockClear();
    state.settings.voice.adapters.local_conversation.agent.backend = 'daemon';
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.sendTextTurn?.({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-home',
      text: 'hello from daemon composer',
    });

    expect(sendVoiceTextTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        userText: 'hello from daemon composer',
        voiceAgentSessions,
      }),
    );
  });
});
