import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { storage } from '@/sync/domains/state/storage';
import { formatSessionFull } from '@/voice/context/contextFormatters';
import { resolveEffectiveVoiceTargetState } from '@/voice/context/resolveEffectiveVoiceTargetState';
import { getVoiceContextFormatterPrefs } from '@/voice/context/voiceContextPrefs';

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildVoiceInitialContext(
  sessionId: string,
  options?: Readonly<{ targetSessionId?: string | null }>,
): string {
  const state: any = storage.getState();
  const targetSessionId = normalizeSessionId(options?.targetSessionId);
  const contextSessionId = targetSessionId && state.sessions?.[targetSessionId] ? targetSessionId : sessionId;
  const session = state.sessions?.[contextSessionId] ?? null;
  if (!session) return '';
  const messages = readStoredSessionMessages(state, contextSessionId);
  const targetState = resolveEffectiveVoiceTargetState(contextSessionId, { targetSessionId });
  const prefs = getVoiceContextFormatterPrefs({
    settings: state.settings,
    sessionId: contextSessionId,
    trackedSessionIds: targetState.trackedSessionIds,
  });
  const heading = contextSessionId === sessionId ? 'THIS IS AN ACTIVE SESSION:' : 'THIS IS THE CURRENT TARGET SESSION:';
  return `${heading}\n\n${formatSessionFull(session, messages, prefs)}`;
}
