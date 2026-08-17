import { describe, expect, it, vi } from 'vitest';

import {
  resolveAgentRealtimeVoiceConversationBinding,
  type AgentRealtimeSessionAvailability,
} from './resolveAgentRealtimeVoiceConversationBinding';

const provider = Object.freeze({ pluginId: 'happier.voice.example', localId: 'realtime' });
const agent = Object.freeze({ pluginId: 'happier.agent.example', localId: 'example' });

const available: AgentRealtimeSessionAvailability = Object.freeze({ available: true });
const declined = (
  code: 'session_unavailable' | 'update_required' | null,
): AgentRealtimeSessionAvailability => Object.freeze({ available: false, code });

describe('resolveAgentRealtimeVoiceConversationBinding', () => {
  it('keeps direct control on the visible session while preserving only the requested target', async () => {
    const inspect = vi.fn(async () => available);
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
      input.sessionId === 'hidden-conversation' ? available : declined('session_unavailable'));
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

  it('declines with the typed cause instead of an unnamed miss on the direct path', async () => {
    await expect(resolveAgentRealtimeVoiceConversationBinding({
      provider,
      agent,
      controlSessionId: 'inactive-control',
      globalSessionId: 'global-voice-home',
      requestedTargetSessionId: null,
      inspect: async () => declined('session_unavailable'),
      ensureGlobalConversation: vi.fn(),
    })).rejects.toMatchObject({
      code: 'session_unavailable',
      message: 'session_unavailable',
    });
  });

  it('declines with the typed cause after obtaining the hidden global conversation', async () => {
    await expect(resolveAgentRealtimeVoiceConversationBinding({
      provider,
      agent,
      controlSessionId: 'global-voice-home',
      globalSessionId: 'global-voice-home',
      requestedTargetSessionId: null,
      inspect: async () => declined('update_required'),
      ensureGlobalConversation: async () => 'hidden-conversation',
    })).rejects.toMatchObject({ code: 'update_required' });
  });

  it('leaves an untyped decline as the unnamed miss its caller already handles', async () => {
    // A decline with no typed reason — the inspect RPC never answered, or the
    // daemon refused without classifying itself — must not be given an invented
    // code; it stays the generic unknown-host-failure path.
    await expect(resolveAgentRealtimeVoiceConversationBinding({
      provider,
      agent,
      controlSessionId: 'visible-control',
      globalSessionId: 'global-voice-home',
      requestedTargetSessionId: null,
      inspect: async () => declined(null),
      ensureGlobalConversation: vi.fn(),
    })).resolves.toBeNull();
  });
});
