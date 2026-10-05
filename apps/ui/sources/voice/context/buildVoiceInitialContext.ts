import { readStoredSessionMessages } from "@happier-dev/session-core/messages";
import { storage } from '@/sync/domains/state/storage';
import { formatSessionFull } from '@/voice/context/contextFormatters';
import { getVoiceContextFormatterPrefs } from '@/voice/context/voiceContextPrefs';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import type { VoiceHostAuthoredContextScope } from '@/voice/session/types';
import { resolveVoiceContextSessionFromState } from './resolveVoiceContextSession';
import { areSessionAddressesEqual, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveVoiceSessionRef } from '@/voice/tools/actionImpl/sessionReference';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveEffectiveVoiceTargetState } from '@/voice/context/resolveEffectiveVoiceTargetState';
import { readSessionIncludedInVoiceFromState } from '@/voice/runtime/voiceUpdatePolicy';

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
      sessionAddress: SessionAddress;
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
    targetSessionAddress?: SessionAddress | null;
    scope?: VoiceHostAuthoredContextScope;
  }>,
): VoiceInitialContextResolution {
  if (options?.scope === 'current_ui_only') {
    return { kind: 'current_ui_only', initialContext: '' };
  }

  const state: any = storage.getState();
  const requestedSessionId = normalizeNonEmptyString(sessionId);
  const requestedSessionAddress = requestedSessionId
    ? resolveVoiceSessionRef(requestedSessionId, state, {
        activeServerId: getActiveServerSnapshot().serverId,
      })?.address ?? null
    : null;
  const targetSessionAddress = options?.targetSessionAddress
    ?? (normalizeNonEmptyString(options?.targetSessionId)
      ? resolveVoiceSessionRef(options?.targetSessionId, state, {
          activeServerId: getActiveServerSnapshot().serverId,
        })?.address ?? null
      : null);
  const targetSession = targetSessionAddress
    ? resolveVoiceContextSessionFromState(targetSessionAddress, state)
    : null;
  const contextSessionAddress = targetSession ? targetSessionAddress : requestedSessionAddress;
  const contextSessionId = contextSessionAddress?.sessionId ?? requestedSessionId;

  if (!contextSessionId) {
    return {
      kind: 'targetless',
      initialContext:
        'VOICE SESSION STARTED\n\n' +
        '<session_context>none</session_context>\n' +
        'No session is currently tracked. Use tools to discover sessions and request the sessionId explicitly before acting.',
    };
  }

  const session = targetSession ?? (contextSessionAddress
    ? resolveVoiceContextSessionFromState(contextSessionAddress, state)
    : null);
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

  const messages = contextSessionAddress && areServerProfileIdentifiersEquivalent(contextSessionAddress.serverId, getActiveServerSnapshot().serverId)
    ? readStoredSessionMessages(state, contextSessionId)
    : [];
  const prefs = getVoiceContextFormatterPrefs({
    settings: state.settings,
    sessionId: contextSessionId,
    sessionAddress: contextSessionAddress,
    includeInVoice: readSessionIncludedInVoiceFromState(state, contextSessionAddress),
    isCurrentAttemptTarget: areSessionAddressesEqual(
      resolveEffectiveVoiceTargetState(contextSessionAddress ?? contextSessionId, options).primaryActionSessionAddress,
      contextSessionAddress,
    ),
  });
  const heading = contextSessionId === requestedSessionId
    ? 'THIS IS AN ACTIVE SESSION:'
    : 'THIS IS THE CURRENT TARGET SESSION:';
  return {
    kind: 'session',
    sessionId: contextSessionId,
    sessionAddress: contextSessionAddress!,
    initialContext: `${heading}\n\n${formatSessionFull(session, messages, prefs, contextSessionAddress ?? undefined)}`,
  };
}

export function buildVoiceInitialContext(
  sessionId: string,
  options?: Readonly<{
    targetSessionId?: string | null;
    targetSessionAddress?: SessionAddress | null;
  }>,
): string {
  const resolution = resolveVoiceInitialContext(sessionId, {
    targetSessionId: options?.targetSessionId,
    targetSessionAddress: options?.targetSessionAddress,
    scope: 'session_context',
  });
  return resolution.kind === 'session' ? resolution.initialContext : '';
}
