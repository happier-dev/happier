import {
  projectSessionActivityCompatibilityV1,
  type SessionActivityCompatibilityMessageCountsV1,
  type SessionListViewV1,
} from '@happier-dev/protocol/sessions/awareness/action';
import { readStoredSessionMessages } from "@happier-dev/session-core/messages";
import { findSessionListLookupSession } from '@/sync/domains/session/listing/sessionListLookupState';
import { listPendingPermissionRequestsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { getServerProfileById, areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { listSessionAddressesForSessionIdFromLocalState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { createAbortRacer } from '@/voice/agent/voiceAgentAbort';

/**
 * Released UI-only counts cover the retained local window, never the whole Session.
 *
 * `windowSeconds` narrows that same already-retained window. It never triggers a transcript
 * fetch: a caller asking about the last minute gets what this host holds for the last minute,
 * and a message whose creation time was never observed stays counted rather than being dropped
 * into a silently emptier window.
 */
function readLocalWindowMessageCounts(
  sessionId: string,
  windowSeconds: number | undefined,
  nowMs: number,
): SessionActivityCompatibilityMessageCountsV1 | undefined {
  const state = storage.getState();
  if (!state.sessionMessages[sessionId]) return undefined;
  const since = typeof windowSeconds === 'number' && Number.isFinite(windowSeconds)
    ? nowMs - windowSeconds * 1000
    : null;
  return readStoredSessionMessages(state, sessionId)
    .filter((message) => since === null
      || typeof message.createdAt !== 'number'
      || message.createdAt >= since)
    .reduce((counts, message) => ({
      total: counts.total + 1,
      assistant: counts.assistant + (message.kind === 'agent-text' || message.kind === 'tool-call' ? 1 : 0),
      user: counts.user + (message.kind === 'user-text' ? 1 : 0),
    }), { total: 0, assistant: 0, user: 0 });
}

export async function getSessionActivityForVoiceTool(params: Readonly<{
  sessionId: string;
  serverId?: string | null;
  signal?: AbortSignal;
  view?: SessionListViewV1;
  windowSeconds?: number;
}>) {
  const sessionId = params.sessionId.trim();
  const fail = (errorCode: string) => ({ ok: false as const, errorCode, errorMessage: errorCode, sessionId });
  if (!sessionId) return fail('invalid_parameters');
  if (params.signal?.aborted) return fail('tool_cancelled');
  const activeServerId = getActiveServerSnapshot().serverId;
  const knownAddresses = listSessionAddressesForSessionIdFromLocalState(storage.getState(), sessionId);
  if (!params.serverId && knownAddresses.length > 1) return fail('session_ambiguous');
  const address = normalizeSessionAddress(params.serverId ?? knownAddresses[0]?.serverId, sessionId);
  if (!address || !getServerProfileById(address.serverId)) return fail('home_unavailable');

  // The existing by-id owner performs authorization/decryption even for an uncached Session.
  // Refresh so an old local row cannot turn revoked access into a successful Action read.
  let acquired: Awaited<ReturnType<typeof sync.ensureSessionVisibleForMessageRoute>>;
  try {
    acquired = await createAbortRacer(params.signal).race(sync.ensureSessionVisibleForMessageRoute(sessionId, {
      serverId: address.serverId,
      forceRefresh: true,
      includeTurnsProjection: false,
      hydrateMessages: false,
    }));
  } catch (error) {
    if (params.signal?.aborted) return fail('tool_cancelled');
    throw error;
  }
  if (params.signal?.aborted) return fail('tool_cancelled');
  if (acquired.kind !== 'available') return fail(acquired.errorCode || acquired.cause);
  const state = storage.getState();
  const raw = state.sessions[sessionId];
  const isActiveHome = areServerProfileIdentifiersEquivalent(address.serverId, getActiveServerSnapshot().serverId);
  const session = raw && (raw.serverId
    ? areServerProfileIdentifiersEquivalent(raw.serverId, address.serverId)
    : isActiveHome)
    ? raw
    : findSessionListLookupSession(state, address)?.session;
  if (!session) return fail('invalid_response');
  const nowMs = Date.now();
  const awareness = projectUiSessionAwareness(session, nowMs);
  if (params.view === 'awareness') return awareness;
  const messageCounts = isActiveHome
    ? readLocalWindowMessageCounts(sessionId, params.windowSeconds, nowMs)
    : undefined;
  const observedPermissionRequestIds = 'agentState' in session && session.agentState != null
    ? listPendingPermissionRequestsFromSession(session).map((request) => request.id)
    : undefined;
  const permissionRequestIds = observedPermissionRequestIds?.length === 0
    && awareness.operational.reasons.includes('permission_required')
    // Counts and identities came from different evidence sets. Preserve the actionable count,
    // but do not turn an empty hydrated cache into a contradictory observed-empty identity set.
    ? undefined
    : observedPermissionRequestIds;
  const result = projectSessionActivityCompatibilityV1({
    awareness,
    facts: {
      presence: typeof session.presence === 'string' ? session.presence : null,
      active: session.active,
      thinking: session.thinking,
      updatedAt: session.updatedAt,
      // A by-id row may expose pending counts without request identities (for example, a shared
      // recipient projection). Omit the identity set in that case; `[]` would falsely say the
      // set was observed empty beside `permissionRequired: true`.
      ...(permissionRequestIds !== undefined ? { permissionRequestIds } : {}),
      ...(messageCounts ? { messageCounts } : {}),
    },
  });
  // This Action returns canonical semantics. The single provider-bound Voice redactor removes
  // permission identifiers according to presentation privacy after execution; privacy must not
  // rewrite `blocked`, `permissionRequired`, or `actionRequired` into false facts here.
  return result;
}
