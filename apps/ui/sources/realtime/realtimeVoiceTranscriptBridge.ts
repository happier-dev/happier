import {
  appendVoiceConversationAssistantText,
  appendVoiceConversationNoteText,
  appendVoiceConversationUserText,
} from '@/voice/sessionBinding/voiceConversationTranscript';

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readGenericRole(payload: Readonly<Record<string, unknown>>): 'user' | 'agent' | null {
  const source = normalizeText(payload.source)?.toLowerCase();
  const role = normalizeText(payload.role)?.toLowerCase();

  if (source === 'user' || role === 'user') return 'user';
  if (source === 'ai' || source === 'agent' || role === 'assistant' || role === 'agent') return 'agent';
  return null;
}

export function appendRealtimeVoiceTranscriptEvent(params: Readonly<{
  conversationSessionId: string | null;
  payload: any;
}>): void {
  const conversationSessionId = normalizeText(params.conversationSessionId);
  if (!conversationSessionId) return;
  const payload = params.payload ?? {};

  if (payload.type === 'user_transcript') {
    const text = normalizeText(payload.user_transcription_event?.user_transcript ?? payload.user_transcript ?? payload.transcript);
    if (!text) return;
    appendVoiceConversationUserText({ conversationSessionId, text });
    return;
  }

  if (payload.type === 'agent_response') {
    const text = normalizeText(payload.agent_response_event?.agent_response ?? payload.agent_response ?? payload.transcript);
    if (!text) return;
    appendVoiceConversationAssistantText({ conversationSessionId, text });
    return;
  }

  if (payload.type === 'agent_response_correction') {
    const text = normalizeText(
      payload.agent_response_correction_event?.corrected_agent_response ?? payload.corrected_agent_response,
    );
    if (!text) return;
    appendVoiceConversationNoteText({
      conversationSessionId,
      text: `[Voice] Agent response corrected: ${text}`,
    });
    return;
  }

  if (payload.type === 'client_tool_call') {
    const toolName = normalizeText(payload.client_tool_call?.tool_name ?? payload.tool_name);
    if (!toolName) return;
    appendVoiceConversationNoteText({
      conversationSessionId,
      text: `[Voice] Tool call: ${toolName}`,
    });
    return;
  }

  if (payload.type === 'agent_tool_response') {
    const toolName = normalizeText(payload.agent_tool_response?.tool_name ?? payload.tool_name);
    if (!toolName) return;
    const isError = payload.agent_tool_response?.is_error === true || payload.is_error === true;
    appendVoiceConversationNoteText({
      conversationSessionId,
      text: `[Voice] Tool result: ${toolName} ${isError ? 'failed' : 'succeeded'}`,
    });
    return;
  }

  const genericText = normalizeText(payload.message ?? payload.text ?? payload.transcript);
  const genericRole = readGenericRole(payload);
  if (!genericText || !genericRole) return;

  if (genericRole === 'user') {
    appendVoiceConversationUserText({
      conversationSessionId,
      text: genericText,
    });
    return;
  }

  appendVoiceConversationAssistantText({
    conversationSessionId,
    text: genericText,
  });
}
