/**
 * Canonical construction and dispatch of session permission decisions.
 *
 * Owns the wire shape shared by foreground session ops (`sessionAllow`/`sessionDeny`)
 * and the headless Android notification executor, so one owner defines how a
 * permission decision is sent. Headless-capable: no dependency on `sessions.ts`
 * or the sync orchestrator, only on the scoped RPC seam and local state helpers.
 */
import { storage } from '../domains/state/storage';
import { nowServerMs } from '../runtime/time';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SessionPermissionResponse } from '@happier-dev/protocol';
import { areServerProfileIdentifiersEquivalent, getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { sessionRpcWithServerScope, sessionRpcWithServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';

export type SessionPermissionRequest = SessionPermissionResponse;

export const NOTIFICATION_PERMISSION_DENY_REASON = 'Denied from notification';

/** The one definition of how a notification button press maps to a permission decision. */
export type NotificationPermissionDecisionRequest = SessionPermissionRequest & (
    | Readonly<{ approved: true; decision: 'approved' }>
    | Readonly<{ approved: false; decision: 'denied'; reason: string }>
);

export function buildNotificationPermissionDecisionRequest(action: 'allow' | 'deny', requestId: string): NotificationPermissionDecisionRequest {
    return action === 'allow'
        ? { id: requestId, approved: true, decision: 'approved' }
        : { id: requestId, approved: false, decision: 'denied', reason: NOTIFICATION_PERMISSION_DENY_REASON };
}

// Best-effort local UX recovery: deny/abort decisions should immediately return
// the session to non-thinking state even if lifecycle events arrive out of order
// or providers publish intermittent thinking=false.
export function applySessionThinkingDecisionRecovery(sessionId: string): void {
    const session = storage.getState().sessions[sessionId];
    storage.getState().clearSessionOptimisticThinking(sessionId);
    storage.getState().clearSessionThinkingGrace(sessionId);
    if (!session || session.thinking !== true) {
        return;
    }

    storage.getState().applySessions([
        {
            ...session,
            thinking: false,
            updatedAt: nowServerMs(),
        },
    ]);
}

/** A successful transport is insufficient: the CLI must accept the decision. */
export function isSessionPermissionDecisionAccepted(result: unknown): boolean {
    return typeof result === 'object' && result !== null && 'ok' in result && result.ok === true;
}

/**
 * One dispatcher for foreground, action-executor and headless permission calls.
 * Target adapters retain their transport semantics; this owner interprets the
 * application acknowledgment and applies local recovery only in its active scope.
 */
export async function dispatchSessionPermissionDecision(params: Readonly<{
    sessionId: string;
    request: SessionPermissionRequest;
    target?: Readonly<{ scope: ServerAccountScope }> | Readonly<{ serverId?: string | null }>;
    networkMode?: 'background-task';
    signal?: AbortSignal;
    onIssued?: () => void;
}>): Promise<unknown> {
    const explicitScope = params.target && 'scope' in params.target ? params.target.scope : null;
    const serverId = explicitScope?.serverId
        ?? (params.target && 'serverId' in params.target ? params.target.serverId : resolvePreferredServerIdForSessionId(params.sessionId));
    const recoveryScope = explicitScope ?? getActiveServerAccountScope();
    const recoveryOccurrenceId = params.request.occurrenceId
        ?? storage.getState().sessions[params.sessionId]?.agentState?.requests?.[params.request.id]?.occurrenceId;
    const method = typeof params.request.occurrenceId === 'string'
        ? SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_TO_OCCURRENCE_V1
        : SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_LEGACY;
    const result = explicitScope
        ? await sessionRpcWithServerAccountScope<unknown, SessionPermissionRequest>({
            scope: explicitScope,
            sessionId: params.sessionId,
            method,
            payload: params.request,
            networkMode: params.networkMode,
            signal: params.signal,
            onIssued: params.onIssued,
        })
        : await sessionRpcWithServerScope<unknown, SessionPermissionRequest>({
            sessionId: params.sessionId,
            serverId,
            method,
            payload: params.request,
            onIssued: params.onIssued,
        });

    const currentOccurrenceId = storage.getState().sessions[params.sessionId]?.agentState?.requests?.[params.request.id]?.occurrenceId;
    const activeScope = getActiveServerAccountScope();
    const stillTargetsActiveScope = recoveryScope
        ? areServerAccountScopesEqual(recoveryScope, activeScope)
        : activeScope === null && !explicitScope;
    if (
        params.request.approved === false
        && isSessionPermissionDecisionAccepted(result)
        && stillTargetsActiveScope
        // Settlement can remove the request before its ACK; a different live
        // occurrence belongs to newer work and must retain its thinking state.
        && (!currentOccurrenceId || currentOccurrenceId === recoveryOccurrenceId)
        && (!serverId || areServerProfileIdentifiersEquivalent(serverId, getActiveServerId()))
    ) {
        try {
            applySessionThinkingDecisionRecovery(params.sessionId);
        } catch {
            // Recovery is best-effort; never replace the authoritative CLI ack.
            console.warn('[permissions] Permission deny local recovery unavailable');
        }
    }
    return result;
}

/** Notification adapter for explicit server/account and one-shot network execution. */
export async function sessionPermissionDecisionWithServerAccountScope(params: Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    requestId: string;
    occurrenceId: string;
    action: 'allow' | 'deny';
    networkMode?: 'background-task';
    signal?: AbortSignal;
    onIssued?: () => void;
}>): Promise<unknown> {
    return await dispatchSessionPermissionDecision({
        sessionId: params.sessionId,
        request: {
            ...buildNotificationPermissionDecisionRequest(params.action, params.requestId),
            occurrenceId: params.occurrenceId,
        },
        target: { scope: params.scope },
        networkMode: params.networkMode,
        signal: params.signal,
        onIssued: params.onIssued,
    });
}
