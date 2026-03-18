import { storage } from '@/sync/domains/state/storage';
import { getVoiceContextFormatterPrefs } from '@/voice/context/voiceContextPrefs';
import { resolveVoiceSessionLabel } from '@/voice/context/resolveVoiceSessionLabel';

import { appendVoiceConversationNoteText } from './voiceConversationTranscript';

function resolveSessionLabel(sessionId: string): string {
  const state: any = storage.getState();
  const prefs = getVoiceContextFormatterPrefs({ settings: state.settings });
  return resolveVoiceSessionLabel(sessionId, prefs, { fallbackLabel: 'the current session' });
}

export function appendVoiceTargetSessionSwitchNote(params: Readonly<{
  conversationSessionId: string;
  previousTargetSessionId: string | null;
  targetSessionId: string | null;
}>): void {
  const nextLabel = params.targetSessionId ? resolveSessionLabel(params.targetSessionId) : 'none';
  const previousLabel = params.previousTargetSessionId
    ? resolveSessionLabel(params.previousTargetSessionId).replace(/^the current session$/, 'the previous session')
    : null;
  const text = previousLabel
    ? `[Voice] Target session changed from ${previousLabel} to ${nextLabel}`
    : `[Voice] Target session set to ${nextLabel}`;
  appendVoiceConversationNoteText({
    conversationSessionId: params.conversationSessionId,
    text,
  });
}
