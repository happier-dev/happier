import { apiSocket } from '@/sync/api/session/apiSocket';
import {
    updateMetadataWithUnreadExternalSessionProgress,
    updateMetadataWithViewedExternalSessionProgress,
} from '@/sync/domains/session/external/externalSessionAttentionMetadata';
import { getFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    clearManualUnreadHold,
    getCurrentSessionViewingActivationId,
    holdManualUnreadForActivation,
} from '@/sync/domains/session/readState/sessionManualUnreadHold';
import { computeManualUnreadReadStateV1 } from '@/sync/domains/state/readStateV1';
import { storage } from '@/sync/domains/state/storage';
import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    buildMachineDisplaysByIdFromMachineList,
    buildSessionListIndexWithServerScope,
} from '@/sync/store/sessionListIndex/buildSessionListIndexWithServerScope';
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
}>): Promise<Readonly<{ response: Response; targetServerId: string }>> {
    const context = await resolveServerScopedSessionContext({
        serverId: params.serverId ?? resolvePreferredServerIdForSessionId(params.sessionId) ?? null,
    });
    const path = `/v2/sessions/${params.sessionId}/read-state`;
    const body = JSON.stringify({ state: params.readState });
    const headers = { 'Content-Type': 'application/json' };

    if (context.scope === 'scoped') {
        return {
            response: await runtimeFetchWithServerReachability({
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
            }),
            targetServerId: context.targetServerId,
        };
    }

    return {
        response: await apiSocket.request(path, { method: 'POST', headers, body }),
        targetServerId: getActiveServerSnapshot().serverId,
    };
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

function applyManualReadStateToMetadata(params: Readonly<{
    metadata: Metadata | null;
    readState: SessionManualReadState;
    sessionSeq: number;
    lastViewedSessionSeq: number | null;
    updatedAt: number;
}>): Metadata | null {
    let metadata = params.metadata;
    if (!metadata) return metadata;

    metadata = params.readState === 'read'
        ? updateMetadataWithViewedExternalSessionProgress(metadata)
        : updateMetadataWithUnreadExternalSessionProgress(metadata);

    if (params.readState === 'unread' && metadata.readStateV1) {
        const legacyResult = computeManualUnreadReadStateV1({
            prev: metadata.readStateV1,
            sessionSeq: params.sessionSeq,
            lastViewedSessionSeq: params.lastViewedSessionSeq,
            now: params.updatedAt,
        });
        if (legacyResult.next) {
            metadata = {
                ...metadata,
                readStateV1: legacyResult.next,
            };
        }
    }

    return metadata;
}

function applyManualReadStateToRenderableMetadata(params: Readonly<{
    metadata: SessionListRenderableSession['metadata'];
    readState: SessionManualReadState;
    sessionSeq: number;
    lastViewedSessionSeq: number | null;
    updatedAt: number;
}>): SessionListRenderableSession['metadata'] {
    const metadata = params.metadata;
    if (!metadata || params.readState !== 'unread' || !metadata.readStateV1) {
        return metadata;
    }

    const legacyResult = computeManualUnreadReadStateV1({
        prev: metadata.readStateV1,
        sessionSeq: params.sessionSeq,
        lastViewedSessionSeq: params.lastViewedSessionSeq,
        now: params.updatedAt,
    });
    if (!legacyResult.next) {
        return metadata;
    }

    return {
        ...metadata,
        readStateV1: legacyResult.next,
    };
}

function buildManualReadStateRenderablePatch(params: Readonly<{
    renderable: SessionListRenderableSession;
    readState: SessionManualReadState;
    lastViewedSessionSeq: number | null;
    updatedAt: number;
}>): Partial<SessionListRenderableSession> {
    const metadata = applyManualReadStateToRenderableMetadata({
        metadata: params.renderable.metadata,
        readState: params.readState,
        sessionSeq: params.renderable.seq,
        lastViewedSessionSeq: params.lastViewedSessionSeq,
        updatedAt: params.updatedAt,
    });

    return {
        hasUnreadMessages: params.readState === 'unread',
        lastViewedSessionSeq: params.lastViewedSessionSeq,
        ...(metadata !== params.renderable.metadata ? { metadata } : {}),
    };
}

function applyManualReadStateToLocalState(params: Readonly<{
    sessionId: string;
    readState: SessionManualReadState;
    lastViewedSessionSeq: number | null;
    ownerServerId: string;
}>): void {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    if (params.ownerServerId && activeServerId && !areServerProfileIdentifiersEquivalent(params.ownerServerId, activeServerId)) {
        storage.setState((state) => {
            const previousEntry = state.concurrentSessionListCacheByServerId?.[params.ownerServerId];
            const previousRows = previousEntry?.sessions;
            const previousRow = previousRows?.[params.sessionId];
            if (!previousEntry || !previousRows || !previousRow) {
                return state;
            }

            const updatedAt = nowServerMs();
            const renderablePatch = buildManualReadStateRenderablePatch({
                renderable: previousRow,
                readState: params.readState,
                lastViewedSessionSeq: params.lastViewedSessionSeq,
                updatedAt,
            });
            if (
                previousRow.hasUnreadMessages === renderablePatch.hasUnreadMessages
                && (previousRow.lastViewedSessionSeq ?? null) === renderablePatch.lastViewedSessionSeq
                && (renderablePatch.metadata === undefined || renderablePatch.metadata === previousRow.metadata)
            ) {
                return state;
            }

            const nextRow: SessionListRenderableSession = {
                ...previousRow,
                ...renderablePatch,
                updatedAt: Math.max(previousRow.updatedAt ?? 0, updatedAt),
            };
            const nextRows: Record<string, SessionListRenderableSession> = {
                ...previousRows,
                [params.sessionId]: nextRow,
            };
            const nextEntry = {
                ...previousEntry,
                sessions: nextRows,
            };
            const previousIndexByServerId = state.sessionListIndexByServerId ?? {};
            const nextIndex = buildSessionListIndexWithServerScope({
                sessions: nextRows,
                machines: buildMachineDisplaysByIdFromMachineList(state.machineListByServerId?.[params.ownerServerId]),
                groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
                activeGroupingV1: state.settings.sessionListActiveGroupingV1,
                inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
                sectionModeV1: state.settings.sessionListSectionModeV1,
                serverScope: {
                    serverId: params.ownerServerId,
                    serverName: previousEntry.serverName ?? undefined,
                },
                previousIndex: previousIndexByServerId[params.ownerServerId] ?? null,
            });

            return {
                ...state,
                concurrentSessionListCacheByServerId: {
                    ...state.concurrentSessionListCacheByServerId,
                    [params.ownerServerId]: nextEntry,
                },
                sessionListRowStateByServerId: {
                    ...(state.sessionListRowStateByServerId ?? {}),
                    [params.ownerServerId]: nextRows,
                },
                sessionListIndexByServerId: {
                    ...previousIndexByServerId,
                    [params.ownerServerId]: nextIndex,
                },
            };
        });
        return;
    }

    const state = storage.getState();
    const session = state.sessions[params.sessionId];
    if (session) {
        const updatedAt = nowServerMs();
        const nextSession: Session = {
            ...session,
            lastViewedSessionSeq: params.lastViewedSessionSeq,
            metadata: applyManualReadStateToMetadata({
                metadata: session.metadata,
                readState: params.readState,
                sessionSeq: session.seq,
                lastViewedSessionSeq: params.lastViewedSessionSeq,
                updatedAt,
            }),
            updatedAt,
        };

        state.applySessions([nextSession]);
        return;
    }

    const renderable = state.sessionListRenderables[params.sessionId];
    if (renderable) {
        const updatedAt = nowServerMs();
        state.applySessionListRenderablePatches([
            {
                sessionId: params.sessionId,
                patch: buildManualReadStateRenderablePatch({
                    renderable,
                    readState: params.readState,
                    lastViewedSessionSeq: params.lastViewedSessionSeq,
                    updatedAt,
                }),
            },
        ]);
    }
}

export async function sessionSetManualReadStateWithServerScope(
    sessionId: string,
    readState: SessionManualReadState,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionSetManualReadStateResponse> {
    try {
        const { response, targetServerId } = await requestSessionReadState({
            sessionId,
            readState,
            serverId: opts?.serverId ?? null,
        });
        if (!response.ok) {
            const message = await response.text().catch(() => '');
            return { success: false, message: message || 'Failed to update session read state' };
        }

        const json = await response.json().catch(() => ({}));
        const parsed = parseReadStateRouteResponse(json, readState);
        applyManualReadStateToLocalState({
            sessionId,
            readState: parsed.readState,
            lastViewedSessionSeq: parsed.lastViewedSessionSeq,
            ownerServerId: targetServerId,
        });

        if (parsed.readState === 'unread' && getFocusedSessionId() === sessionId) {
            holdManualUnreadForActivation({
                sessionId,
                sessionSeq: storage.getState().sessions[sessionId]?.seq ?? 0,
                activationId: getCurrentSessionViewingActivationId(sessionId),
            });
        } else if (parsed.readState === 'read') {
            clearManualUnreadHold({ sessionId });
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
