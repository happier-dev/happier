import { describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

const toggleLocalVoiceTurn = vi.fn(async () => {});
const stopLocalVoiceSession = vi.fn(async () => {});
const appendLocalVoiceAgentContextUpdate = vi.fn();
const getLocalVoiceState = vi.fn(() => ({
  status: 'idle' as const,
  sessionId: null as string | null,
  error: null as Error | null,
}));

const state: any = {
  settings: {
    voice: {
      providerId: 'local_conversation',
      adapters: {
        local_conversation: { conversationMode: 'agent' },
      },
    },
  },
};

vi.mock('@/sync/domains/state/storage', () => ({
  storage: { getState: () => state },
}));

vi.mock('@/voice/local/localVoiceEngine', () => ({
  toggleLocalVoiceTurn,
  stopLocalVoiceSession,
  appendLocalVoiceAgentContextUpdate,
  getLocalVoiceState,
}));

describe('local conversation voice adapter', () => {
  it('delegates toggle to local voice engine', async () => {
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.toggle({ sessionId: 's1' });
    expect(toggleLocalVoiceTurn).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
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
});
