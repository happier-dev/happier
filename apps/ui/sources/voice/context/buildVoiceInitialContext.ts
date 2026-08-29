import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { storage } from '@/sync/domains/state/storage';
import { formatSessionFull } from '@/voice/context/contextFormatters';
import { resolveEffectiveVoiceTargetState } from '@/voice/context/resolveEffectiveVoiceTargetState';
import { getVoiceContextFormatterPrefs } from '@/voice/context/voiceContextPrefs';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import type { VoiceHostAuthoredContextScope } from '@/voice/session/types';
import { resolveVoiceContextSessionFromState } from './resolveVoiceContextSession';

export type VoiceInitialContextResolution =
  | Readonly<{
      kind: 'current_ui_only';
      initialContext: '';
    }>
  | Readonly<{
      kind: 'targetless';
      initialContext: string;
    }>
  | Readonly<{
      kind: 'missing_session';
      sessionId: string;
      initialContext: string;
    }>
  | Readonly<{
      kind: 'session';
      sessionId: string;
      initialContext: string;
    }>;

/**
 * Canonical initial-context resolver for both direct/local Voice startup and
 * realtime attempt startup. It owns session selection and formatting, while
 * callers retain their distinct attempt lifecycle and delivery behavior.
 */
export function resolveVoiceInitialContext(
  sessionId: string,
  options?: Readonly<{
    targetSessionId?: string | null;
    scope?: VoiceHostAuthoredContextScope;
  }>,
): VoiceInitialContextResolution {
  if (options?.scope === 'current_ui_only') {
    return { kind: 'current_ui_only', initialContext: '' };
  }

  const state: any = storage.getState();
  const requestedSessionId = normalizeNonEmptyString(sessionId);
  const targetSessionId = normalizeNonEmptyString(options?.targetSessionId);
  const targetSession = targetSessionId
    ? resolveVoiceContextSessionFromState(targetSessionId, state)
    : null;
  const contextSessionId = targetSession ? targetSessionId : requestedSessionId;

  if (!contextSessionId) {
    return {
      kind: 'targetless',
      initialContext:
        'VOICE SESSION STARTED\n\n' +
        '<session_context>none</session_context>\n' +
        'No session is currently tracked. Use tools to discover sessions and request the sessionId explicitly before acting.',
    };
  }

  const session = targetSession ?? resolveVoiceContextSessionFromState(contextSessionId, state);
  if (!session) {
    return {
      kind: 'missing_session',
      sessionId: contextSessionId,
      initialContext:
        'VOICE SESSION STARTED\n\n' +
        `<session_id>${contextSessionId}</session_id>\n` +
        '<session_not_found>true</session_not_found>\n' +
        'Use tools to list sessions and select a valid sessionId.',
    };
  }

  const messages = readStoredSessionMessages(state, contextSessionId);
  const targetState = resolveEffectiveVoiceTargetState(contextSessionId, { targetSessionId });
  const prefs = getVoiceContextFormatterPrefs({
    settings: state.settings,
    sessionId: contextSessionId,
    trackedSessionIds: targetState.trackedSessionIds,
  });
  const heading = contextSessionId === requestedSessionId
    ? 'THIS IS AN ACTIVE SESSION:'
    : 'THIS IS THE CURRENT TARGET SESSION:';
  return {
    kind: 'session',
    sessionId: contextSessionId,
    initialContext: `${heading}\n\n${formatSessionFull(session, messages, prefs)}`,
  };
}

export function buildVoiceInitialContext(
  sessionId: string,
  options?: Readonly<{ targetSessionId?: string | null }>,
): string {
  const resolution = resolveVoiceInitialContext(sessionId, {
    targetSessionId: options?.targetSessionId,
    scope: 'session_context',
  });
  return resolution.kind === 'session' ? resolution.initialContext : '';
}
