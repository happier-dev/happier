import { describe, expect, it, vi } from 'vitest';

import { resolveAgentRealtimeVoiceConversationBinding } from './resolveAgentRealtimeVoiceConversationBinding';

const provider = Object.freeze({ pluginId: 'happier.voice.example', localId: 'realtime' });
const agent = Object.freeze({ pluginId: 'happier.agent.example', localId: 'example' });

describe('resolveAgentRealtimeVoiceConversationBinding', () => {
  it('keeps direct control on the visible session while preserving only the requested target', async () => {
    const inspect = vi.fn(async () => true);
    const ensureGlobalConversation = vi.fn();

    await expect(resolveAgentRealtimeVoiceConversationBinding({
      provider,
      agent,
      controlSessionId: 'visible-control',
      globalSessionId: 'global-voice-home',
      requestedTargetSessionId: 'requested-target',
      inspect,
      ensureGlobalConversation,
    })).resolves.toEqual({
      conversationSessionId: 'visible-control',
      transcriptMode: 'native_session',
      targetSessionId: 'requested-target',
    });
    expect(inspect).toHaveBeenCalledWith({
      sessionId: 'visible-control',
      provider,
      agent,
    });
    expect(ensureGlobalConversation).not.toHaveBeenCalled();
  });

  it('always obtains and verifies a hidden global conversation without attaching the requested target', async () => {
    const inspect = vi.fn(async (input: Readonly<{ sessionId: string }>) =>
      input.sessionId === 'hidden-conversation');
    const ensureGlobalConversation = vi.fn(async (input: Readonly<{
      agent: typeof agent;
      isReusableSession(input: Readonly<{ sessionId: string }>): Promise<boolean>;
    }>) => {
      expect(input.agent).toBe(agent);
      await expect(input.isReusableSession({ sessionId: 'wrong-agent-session' })).resolves.toBe(false);
      return 'hidden-conversation';
    });

    await expect(resolveAgentRealtimeVoiceConversationBinding({
      provider,
      agent,
      controlSessionId: 'global-voice-home',
      globalSessionId: 'global-voice-home',
      requestedTargetSessionId: 'visible-target',
      inspect,
      ensureGlobalConversation,
    })).resolves.toEqual({
      conversationSessionId: 'hidden-conversation',
      transcriptMode: 'native_session',
      targetSessionId: 'visible-target',
    });
    expect(ensureGlobalConversation).toHaveBeenCalledOnce();
    expect(inspect).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'visible-target',
    }));
  });
});
