import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveViewingSessionActivationId, getActiveViewingSessionId } from '@/sync/domains/session/activeViewingSession';
import { clearManualUnreadHold, holdManualUnreadForActivation } from '@/sync/domains/session/readState/sessionManualUnreadHold';
import { computeManualUnreadReadStateV1 } from '@/sync/domains/state/readStateV1';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import { nowServerMs } from '@/sync/runtime/time';

export type SessionManualReadState = 'read' | 'unread';

export type SessionSetManualReadStateResponse = Readonly<{
    success: boolean;
    readState?: SessionManualReadState;
    lastViewedSessionSeq?: number | null;
    didChange?: boolean;
    message?: string;
}>;

type ReadStateRouteResponse = Readonly<{
    success?: unknown;
    state?: unknown;
    lastViewedSessionSeq?: unknown;
    didChange?: unknown;
}>;

async function requestSessionReadState(params: Readonly<{
    sessionId: string;
    readState: SessionManualReadState;
    serverId?: string | null;
}>): Promise<Response> {
    const context = await resolveServerScopedSessionContext({
        serverId: params.serverId ?? resolvePreferredServerIdForSessionId(params.sessionId) ?? null,
    });
    const path = `/v2/sessions/${params.sessionId}/read-state`;
    const body = JSON.stringify({ state: params.readState });
    const headers = { 'Content-Type': 'application/json' };

    if (context.scope === 'active') {
        return await apiSocket.request(path, { method: 'POST', headers, body });
    }

    return await runtimeFetchWithServerReachability({
        serverUrl: context.targetServerUrl,
        token: context.token,
        url: `${context.targetServerUrl}${path}`,
        init: {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${context.token}`,
                ...headers,
            },
            body,
        },
        timeoutMs: context.timeoutMs,
    });
}

function parseReadStateRouteResponse(json: unknown, fallbackReadState: SessionManualReadState): {
    readState: SessionManualReadState;
    lastViewedSessionSeq: number | null;
    didChange: boolean;
} {
    const value = (json ?? {}) as ReadStateRouteResponse;
    const readState = value.state === 'read' || value.state === 'unread'
        ? value.state
        : fallbackReadState;
    const lastViewedSessionSeq =
        typeof value.lastViewedSessionSeq === 'number' && Number.isFinite(value.lastViewedSessionSeq)
            ? Math.max(0, Math.trunc(value.lastViewedSessionSeq))
            : null;
    const didChange = value.didChange === true;
    return { readState, lastViewedSessionSeq, didChange };
}

function applyManualReadStateToLocalSession(params: Readonly<{
    sessionId: string;
    readState: SessionManualReadState;
    lastViewedSessionSeq: number | null;
}>): void {
    const state = storage.getState();
    if (state.sessionListRenderables?.[params.sessionId]) {
        state.applySessionListRenderablePatches?.([{
            sessionId: params.sessionId,
            patch: {
                lastViewedSessionSeq: params.lastViewedSessionSeq,
                hasUnreadMessages: params.readState === 'unread',
            },
        }]);
    }

    const session = state.sessions[params.sessionId];
    if (!session) return;

    const nextSession: Session = {
        ...session,
        lastViewedSessionSeq: params.lastViewedSessionSeq,
        updatedAt: nowServerMs(),
    };

    if (params.readState === 'unread' && session.metadata?.readStateV1) {
        const legacyResult = computeManualUnreadReadStateV1({
            prev: session.metadata.readStateV1,
            sessionSeq: session.seq,
            lastViewedSessionSeq: params.lastViewedSessionSeq,
            now: nextSession.updatedAt,
        });
        if (legacyResult.next) {
            nextSession.metadata = {
                ...session.metadata,
                readStateV1: legacyResult.next,
            };
        }
    }

    state.applySessions([nextSession]);
}

export async function sessionSetManualReadStateWithServerScope(
    sessionId: string,
    readState: SessionManualReadState,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionSetManualReadStateResponse> {
    try {
        const response = await requestSessionReadState({ sessionId, readState, serverId: opts?.serverId ?? null });
        if (!response.ok) {
            const message = await response.text().catch(() => '');
            return { success: false, message: message || 'Failed to update session read state' };
        }

        const json = await response.json().catch(() => ({}));
        const parsed = parseReadStateRouteResponse(json, readState);
        applyManualReadStateToLocalSession({
            sessionId,
            readState: parsed.readState,
            lastViewedSessionSeq: parsed.lastViewedSessionSeq,
        });
        if (parsed.readState === 'unread' && getActiveViewingSessionId() === sessionId) {
            holdManualUnreadForActivation({
                sessionId,
                sessionSeq: storage.getState().sessions[sessionId]?.seq ?? 0,
                activationId: getActiveViewingSessionActivationId(),
            });
        } else if (parsed.readState === 'read') {
            const activeActivationId = getActiveViewingSessionId() === sessionId
                ? getActiveViewingSessionActivationId()
                : null;
            if (activeActivationId !== null) {
                clearManualUnreadHold({ sessionId, activationId: activeActivationId });
            }
        }

        return {
            success: true,
            readState: parsed.readState,
            lastViewedSessionSeq: parsed.lastViewedSessionSeq,
            didChange: parsed.didChange,
        };
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}
