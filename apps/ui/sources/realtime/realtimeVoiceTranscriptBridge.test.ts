import { beforeEach, describe, expect, it, vi } from 'vitest';

const appendUser = vi.fn();
const appendAssistant = vi.fn();
const appendNote = vi.fn();

vi.mock('@/voice/sessionBinding/voiceConversationTranscript', () => ({
  appendVoiceConversationUserText: (params: any) => appendUser(params),
  appendVoiceConversationAssistantText: (params: any) => appendAssistant(params),
  appendVoiceConversationNoteText: (params: any) => appendNote(params),
}));

describe('appendRealtimeVoiceTranscriptEvent', () => {
  beforeEach(() => {
    appendUser.mockReset();
    appendAssistant.mockReset();
    appendNote.mockReset();
  });

  it('maps user transcript payloads into hidden conversation user turns', async () => {
    const { appendRealtimeVoiceTranscriptEvent } = await import('./realtimeVoiceTranscriptBridge');

    appendRealtimeVoiceTranscriptEvent({
      conversationSessionId: 'carrier-s1',
      payload: {
        type: 'user_transcript',
        user_transcription_event: {
          user_transcript: 'open the session',
          event_id: 1,
        },
      },
    });

    expect(appendUser).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'open the session',
    });
  });

  it('maps agent response correction payloads into hidden conversation note turns', async () => {
    const { appendRealtimeVoiceTranscriptEvent } = await import('./realtimeVoiceTranscriptBridge');

    appendRealtimeVoiceTranscriptEvent({
      conversationSessionId: 'carrier-s1',
      payload: {
        type: 'agent_response_correction',
        agent_response_correction_event: {
          original_agent_response: 'old answer',
          corrected_agent_response: 'new answer',
          event_id: 2,
        },
      },
    });

    expect(appendNote).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: '[Voice] Agent response corrected: new answer',
    });
  });

  it('maps generic assistant message payloads into hidden conversation assistant turns', async () => {
    const { appendRealtimeVoiceTranscriptEvent } = await import('./realtimeVoiceTranscriptBridge');

    appendRealtimeVoiceTranscriptEvent({
      conversationSessionId: 'carrier-s1',
      payload: {
        source: 'ai',
        role: 'agent',
        message: 'I am Happier Voice.',
      },
    });

    expect(appendAssistant).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'I am Happier Voice.',
    });
  });

  it('maps generic user message payloads into hidden conversation user turns', async () => {
    const { appendRealtimeVoiceTranscriptEvent } = await import('./realtimeVoiceTranscriptBridge');

    appendRealtimeVoiceTranscriptEvent({
      conversationSessionId: 'carrier-s1',
      payload: {
        source: 'user',
        role: 'user',
        message: 'Open the session picker.',
      },
    });

    expect(appendUser).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'Open the session picker.',
    });
  });

  it('maps tool lifecycle payloads into hidden conversation note turns', async () => {
    const { appendRealtimeVoiceTranscriptEvent } = await import('./realtimeVoiceTranscriptBridge');

    appendRealtimeVoiceTranscriptEvent({
      conversationSessionId: 'carrier-s1',
      payload: {
        type: 'client_tool_call',
        client_tool_call: {
          tool_name: 'sendSessionMessage',
          tool_call_id: 'tool_1',
          parameters: { message: 'hello' },
          event_id: 3,
        },
      },
    });
    appendRealtimeVoiceTranscriptEvent({
      conversationSessionId: 'carrier-s1',
      payload: {
        type: 'agent_tool_response',
        agent_tool_response: {
          tool_name: 'sendSessionMessage',
          tool_call_id: 'tool_1',
          tool_type: 'client',
          is_error: false,
          is_called: true,
          event_id: 4,
        },
      },
    });

    expect(appendNote).toHaveBeenNthCalledWith(1, {
      conversationSessionId: 'carrier-s1',
      text: '[Voice] Tool call: sendSessionMessage',
    });
    expect(appendNote).toHaveBeenNthCalledWith(2, {
      conversationSessionId: 'carrier-s1',
      text: '[Voice] Tool result: sendSessionMessage succeeded',
    });
  });
});
