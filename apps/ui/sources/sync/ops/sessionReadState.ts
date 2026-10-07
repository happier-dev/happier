import { sync } from '@/sync/sync';
import {
    updateMetadataWithUnreadExternalSessionProgress,
    updateMetadataWithViewedExternalSessionProgress,
} from '@/sync/domains/session/external/externalSessionAttentionMetadata';
import { getFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import { hasUnreadActivityForSessionViewer } from '@/sync/domains/session/readState/sessionViewer';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    clearManualUnreadHold,
    getCurrentSessionViewingActivationId,
    holdManualUnreadForActivation,
} from '@/sync/domains/session/readState/sessionManualUnreadHold';
import { SessionReadStateSetResultV1Schema } from '@happier-dev/protocol/sessions/readState/actions';
import { SessionViewerProjectionV1Schema, type SessionViewerProjectionV1 } from '@happier-dev/protocol/sessions/personal/viewer';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { nowServerMs } from '@/sync/runtime/time';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';

export type SessionManualReadState = 'read' | 'unread';

export type SessionSetManualReadStateResponse = Readonly<{
    success: boolean;
    readState?: SessionManualReadState;
    lastViewedSessionSeq?: number | null;
    didChange?: boolean;
    message?: string;
}>;

async function executeManualReadStateAction(params: Readonly<{
    sessionId: string;
    readState: SessionManualReadState;
    serverId: string;
    signal?: AbortSignal;
}>): Promise<Readonly<{
    ok: true;
    value: ReturnType<typeof SessionReadStateSetResultV1Schema.parse>;
}> | Readonly<{ ok: false; error: string; viewer?: SessionViewerProjectionV1 }>> {
    const outcome = await createDefaultActionExecutor().execute('session.read_state.set', {
        sessionId: params.sessionId,
        state: params.readState,
    }, {
        surface: 'ui',
        authority: 'present_user',
        actionCaller: { kind: 'host' },
        serverId: params.serverId,
        ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
    if (!outcome.ok) {
        const viewer = SessionViewerProjectionV1Schema.safeParse(
            outcome.details && typeof outcome.details === 'object' && 'viewer' in outcome.details
                ? (outcome.details as Record<string, unknown>).viewer
                : undefined,
        );
        return {
            ok: false,
            error: String(outcome.errorCode ?? outcome.error),
            ...(viewer.success ? { viewer: viewer.data } : {}),
        };
    }
    return { ok: true, value: SessionReadStateSetResultV1Schema.parse(outcome.result) };
}

function applyManualReadStateToMetadata(params: Readonly<{
    metadata: Metadata | null;
    readState: SessionManualReadState;
}>): Metadata | null {
    const metadata = params.metadata;
    if (!metadata) return metadata;

    return params.readState === 'read'
        ? updateMetadataWithViewedExternalSessionProgress(metadata)
        : updateMetadataWithUnreadExternalSessionProgress(metadata);
}

function buildReadStateRenderablePatch(params: Readonly<{
    readState?: SessionManualReadState;
    lastViewedSessionSeq: number | null;
    viewer?: SessionViewerProjectionV1;
}>): Partial<SessionListRenderableSession> {
    return {
        hasUnreadMessages: params.viewer
            ? hasUnreadActivityForSessionViewer(params.viewer)
            : params.readState === 'unread',
        lastViewedSessionSeq: params.lastViewedSessionSeq,
        ...(params.viewer ? { viewer: params.viewer } : {}),
    };
}

function applyReadStateToLocalState(params: Readonly<{
    sessionId: string;
    readState?: SessionManualReadState;
    lastViewedSessionSeq: number | null;
    ownerServerId: string;
    viewer?: SessionViewerProjectionV1;
}>): void {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    if (params.ownerServerId && activeServerId && !areServerProfileIdentifiersEquivalent(params.ownerServerId, activeServerId)) {
        const state = storage.getState();
        const previousRow = state.sessionListRowsByServerId?.[params.ownerServerId]?.[params.sessionId];
        if (!previousRow) return;
        const renderablePatch = buildReadStateRenderablePatch({
            viewer: params.viewer,
            readState: params.readState,
            lastViewedSessionSeq: params.lastViewedSessionSeq,
        });
        if (
            previousRow.hasUnreadMessages === renderablePatch.hasUnreadMessages
            && (previousRow.lastViewedSessionSeq ?? null) === renderablePatch.lastViewedSessionSeq
            && renderablePatch.viewer === undefined
        ) {
            return;
        }
        state.applyServerScopedSessionListRowPatches(params.ownerServerId, [{
            sessionId: params.sessionId,
            patch: {
                ...renderablePatch,
                updatedAt: Math.max(previousRow.updatedAt ?? 0, nowServerMs()),
            },
        }]);
        return;
    }

    const state = storage.getState();
    const session = state.sessions[params.sessionId];
    if (session) {
        const updatedAt = nowServerMs();
        const metadata = readSessionOwnerMetadataView(session);
        const ownerMetadataView = params.readState
            ? applyManualReadStateToMetadata({ metadata, readState: params.readState })
            : metadata;
        const nextSession: Session = {
            ...session,
            ...(params.viewer ? { viewer: params.viewer } : {}),
            lastViewedSessionSeq: params.lastViewedSessionSeq,
            ...(readSessionMetadataLayoutVersion(
                session.metadataLayoutVersion,
            ) === 1
                ? { ownerMetadataView }
                : readSessionMetadataLayoutVersion(
                    session.metadataLayoutVersion,
                ) === 0
                    ? { metadata: ownerMetadataView }
                    : {}),
            updatedAt,
        };

        state.applySessions([nextSession]);
        return;
    }

    const renderable = state.sessionListRowsByServerId[params.ownerServerId]?.[params.sessionId];
    if (renderable) {
        state.applyServerScopedSessionListRowPatches(params.ownerServerId, [
            {
                sessionId: params.sessionId,
                patch: buildReadStateRenderablePatch({
                    viewer: params.viewer,
                    readState: params.readState,
                    lastViewedSessionSeq: params.lastViewedSessionSeq,
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
    const activeServerId = getActiveServerSnapshot().serverId;
    const targetServerId = opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId) ?? activeServerId;
    const state = storage.getState();
    const sourceAccountId = state.profileScope?.accountId ?? null;
    const isCurrentAccount = () => (
        !areServerProfileIdentifiersEquivalent(targetServerId, activeServerId)
        || !areServerProfileIdentifiersEquivalent(targetServerId, getActiveServerSnapshot().serverId)
        || (storage.getState().profileScope?.accountId ?? null) === sourceAccountId
    );
    const readCachedSession = () => {
        const current = storage.getState();
        return areServerProfileIdentifiersEquivalent(targetServerId, getActiveServerSnapshot().serverId)
            ? current.sessions[sessionId] ?? current.sessionListRowsByServerId?.[targetServerId]?.[sessionId]
            : current.sessionListRowsByServerId?.[targetServerId]?.[sessionId];
    };
    // The Home admits an explicit mark-read/mark-unread from any reader of the
    // transcript and seeds the actor's own row when none exists, so a cached
    // `not_started` viewer is not a reason to refuse the request locally. A
    // Home that does refuse still answers `session_not_tracked`, handled below.
    const cachedSession = readCachedSession();
    try {
        if (!isCurrentAccount()) return { success: false, message: 'session_account_changed' };
        const outcome = await executeManualReadStateAction({
            sessionId,
            readState,
            serverId: targetServerId,
        });
        if (!isCurrentAccount()) return { success: false, message: 'session_account_changed' };
        if (!outcome.ok) {
            if (outcome.error === 'session_not_tracked') {
                sync.invalidateSessionListSnapshot(targetServerId);
                if (outcome.viewer) {
                    applyReadStateToLocalState({
                        sessionId,
                        ownerServerId: targetServerId,
                        viewer: outcome.viewer,
                        lastViewedSessionSeq: outcome.viewer.readState.state === 'tracking'
                            ? outcome.viewer.readState.lastViewedSessionSeq
                            : cachedSession?.seq ?? null,
                    });
                }
            }
            return { success: false, message: outcome.error };
        }
        const parsed = outcome.value;
        sync.invalidateSessionListSnapshot(targetServerId);
        applyReadStateToLocalState({
            sessionId,
            readState: parsed.state === 'empty' ? undefined : parsed.state,
            lastViewedSessionSeq: parsed.lastViewedSessionSeq,
            ownerServerId: targetServerId,
            viewer: parsed.viewer,
        });

        const isActiveHome = areServerProfileIdentifiersEquivalent(targetServerId, getActiveServerSnapshot().serverId);
        if (isActiveHome && parsed.state === 'unread' && getFocusedSessionId() === sessionId) {
            holdManualUnreadForActivation({
                sessionId,
                sessionSeq: storage.getState().sessions[sessionId]?.seq ?? 0,
                activationId: getCurrentSessionViewingActivationId(sessionId),
            });
        } else if (isActiveHome && parsed.state === 'read') {
            clearManualUnreadHold({ sessionId });
        }

        return {
            success: true,
            ...(parsed.state === 'empty' ? {} : { readState: parsed.state }),
            lastViewedSessionSeq: parsed.lastViewedSessionSeq,
            didChange: parsed.didChange,
        };
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}
