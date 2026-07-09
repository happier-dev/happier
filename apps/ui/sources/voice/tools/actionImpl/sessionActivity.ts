import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { findSessionListLookupSession } from '@/sync/domains/session/listing/sessionListLookupState';
import {
  deriveLatestPendingRequestObservedAtFromSession,
  derivePendingRequestFlagsFromSession,
  listPendingPermissionRequestsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/runtimePresentation';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';

export async function getSessionActivityForVoiceTool(params: Readonly<{ sessionId: string; windowSeconds?: number }>): Promise<
  | Readonly<{
    ok: true;
    sessionId: string;
    presence: string | null;
    active: boolean;
    thinking: boolean;
    working: boolean;
    blocked: boolean;
    permissionRequired: boolean;
    actionRequired: boolean;
    updatedAt: number | null;
    permissionRequestIds: readonly string[];
    messageCounts: Readonly<{ total: number; assistant: number; user: number }>;
  }>
  | Readonly<{ ok: false; errorCode: string; errorMessage: string; sessionId: string }>
> {
  const sessionId = String(params.sessionId ?? '').trim();
  const state: any = storage.getState();
  const session = (findSessionListLookupSession(state, sessionId)?.session ?? null) as Session | null;
  if (!session) {
    return { ok: false, errorCode: 'session_not_found', errorMessage: 'session_not_found', sessionId };
  }

  // Pull-path symmetry with the push hook (`context/voiceHooks.ts`): when the user disables
  // permission-request sharing, the activity tool must not surface pending/blocked/permission state.
  const sharePermissionRequests = readVoicePrivacySettings(state?.settings).sharePermissionRequests;
  const messages = readStoredSessionMessages(state, sessionId) as any[];
  const permissionRequestIds = sharePermissionRequests
    ? listPendingPermissionRequestsFromSession(session, messages).map((request) => request.id)
    : [];
  const pendingFlags = sharePermissionRequests
    ? derivePendingRequestFlagsFromSession(session, messages)
    : { hasPendingPermissionRequests: false, hasPendingUserActionRequests: false };
  const runtimeState = deriveSessionRuntimePresentationState({
    active: session.active,
    activeAt: session.activeAt,
    presence: session.presence,
    thinking: session.thinking,
    thinkingAt: session.thinkingAt,
    optimisticThinkingAt: session.optimisticThinkingAt ?? null,
    hasPendingUserMessages: (session.pendingCount ?? 0) > 0,
    latestTurnStatus: session.latestTurnStatus ?? null,
    latestTurnStatusObservedAt: session.latestTurnStatusObservedAt ?? null,
    meaningfulActivityAt: session.meaningfulActivityAt ?? null,
    lastRuntimeIssue: session.lastRuntimeIssue ?? null,
    hasPendingPermissionRequests: pendingFlags.hasPendingPermissionRequests,
    hasPendingUserActionRequests: pendingFlags.hasPendingUserActionRequests,
    pendingRequestObservedAt: sharePermissionRequests
      ? deriveLatestPendingRequestObservedAtFromSession(session, messages)
      : null,
  });

  const messageCounts = messages.reduce(
    (acc, m) => {
      const kind = m?.kind;
      acc.total += 1;
      if (kind === 'agent-text' || kind === 'tool-call') acc.assistant += 1;
      if (kind === 'user-text') acc.user += 1;
      return acc;
    },
    { total: 0, assistant: 0, user: 0 },
  );

  return {
    ok: true,
    sessionId,
    presence: typeof session?.presence === 'string' ? session.presence : null,
    active: Boolean(session?.active),
    thinking: Boolean(session?.thinking),
    working: runtimeState.working,
    blocked: runtimeState.freshPermissionRequired || runtimeState.freshActionRequired,
    permissionRequired: runtimeState.freshPermissionRequired,
    actionRequired: runtimeState.freshActionRequired,
    updatedAt: typeof session?.updatedAt === 'number' ? session.updatedAt : null,
    permissionRequestIds,
    messageCounts,
  };
}
