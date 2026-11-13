import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { PendingRequestedActionV1, SessionOrganizationSessionAppearancePresentation } from '@happier-dev/protocol';
import {
    setSessionAppearance as setSessionAppearanceApi,
    setSessionAppearancePresentation as setSessionAppearancePresentationApi,
} from '@/sync/api/session/sessionOrganizationApi';
import {
    mergeSessionAppearanceDisplay,
    mergeSessionAppearancePresentation,
    readEffectiveSessionParentPlacement,
    type SessionParentPlacement,
    type SessionAppearancePatch,
} from '@/sync/domains/session/organization/sessionAppearance';
import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization/keys';
import { createCanPlaceSessionUnderParent, resolveSessionParentId } from '@/sync/domains/session/listing/sessionParentPlacement';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { resolveServerIdForSessionIdFromLocalState } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { sendSessionMessageWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage';
import { randomUUID } from '@/platform/randomUUID';
import { openSessionOrganizationDisplayEnvelope, prepareSessionOrganizationDisplayEnvelopeForWrite } from './sessionOrganizationDisplayEnvelope';
import { resolveSessionOrganizationMutationScope } from '@/sync/domains/session/organization/mutationScope';

function buildParentPlacementValidationItems(
    state: Pick<StorageState, 'sessions' | 'sessionListViewDataByServerId'>,
    serverId: string,
) {
    const items = (state.sessionListViewDataByServerId[serverId] ?? [])
        .map(item => ({ ...item, serverId: item.serverId ?? serverId }));
    const listedSessionIds = new Set(items.flatMap(item => item.type === 'session' && item.serverId === serverId
        ? [item.session.id]
        : []));
    // The picker also exposes hydrated sessions outside the paged list projection. Validate the
    // protected write against that same same-server graph so a selection can persist after reload.
    for (const session of Object.values(state.sessions)) {
        if (listedSessionIds.has(session.id)) continue;
        if (resolveServerIdForSessionIdFromLocalState(state, session.id) !== serverId) continue;
        items.push({ type: 'session', serverId, session: buildSessionListRenderableFromSession(session) });
        listedSessionIds.add(session.id);
    }
    return items;
}

function canPlaceSessionUnderParent(params: Readonly<{
    state: Pick<StorageState, 'sessions' | 'sessionListViewDataByServerId' | 'sessionOrganizationAppearancesBySessionKey' | 'sessionOrganizationAppearancePresentationsBySessionKey'>;
    serverId: string;
    sessionId: string;
    parentSessionId: string;
}>): boolean {
    const items = buildParentPlacementValidationItems(params.state, params.serverId);
    return createCanPlaceSessionUnderParent({
        items,
        appearances: params.state.sessionOrganizationAppearancesBySessionKey,
        appearancePresentations: params.state.sessionOrganizationAppearancePresentationsBySessionKey,
        serverId: params.serverId,
        sessionId: params.sessionId,
    })(params.parentSessionId);
}

const SESSION_PLACEMENT_REPORTING_REQUESTED_ACTION: PendingRequestedActionV1 = { v: 1, kind: 'enqueue' };

export type SessionParentPlacementDeliveryResult =
    | Readonly<{
        ok: true;
        placement: SessionParentPlacement['kind'];
        /** Null only when top-level placement had no real former parent to clear. */
        instructionLocalId: string | null;
    }>
    /** Placement was not persisted and no reporting instruction was queued. */
    | Readonly<{
        ok: false;
        stage: 'placement';
        placement: SessionParentPlacement['kind'];
        error: string;
    }>
    /** Placement is persisted; an explicit transport rejection may be retried with the same local id. */
    | Readonly<{
        ok: false;
        stage: 'delivery';
        placement: SessionParentPlacement['kind'];
        errorCode: string;
        error: string;
        instruction: Readonly<{ localId: string; message: string }>;
        retry: () => Promise<SessionParentPlacementDeliveryResult>;
    }>
    /** Placement is persisted, but a thrown transport outcome is unknown and is never retried automatically. */
    | Readonly<{
        ok: false;
        stage: 'not_current';
        placement: SessionParentPlacement['kind'];
        error: 'placement_superseded';
        instruction: Readonly<{ localId: string; message: string }>;
    }>
    | Readonly<{
        ok: false;
        stage: 'delivery_uncertain';
        placement: SessionParentPlacement['kind'];
        error: string;
        instruction: Readonly<{ localId: string; message: string }>;
    }>;

function resolveCurrentSessionParentId(params: Readonly<{ serverId: string; sessionId: string }>): string | null {
    const state = getStorage().getState();
    const items = buildParentPlacementValidationItems(state, params.serverId);
    const row = items.find(item => item.type === 'session'
        && item.serverId === params.serverId
        && item.session.id === params.sessionId);
    if (!row || row.type !== 'session') return null;
    const parentSessionId = resolveSessionParentId(
        row,
        state.sessionOrganizationAppearancesBySessionKey,
        state.sessionOrganizationAppearancePresentationsBySessionKey,
    );
    return parentSessionId;
}

function readStoredSessionParentPlacement(params: Readonly<{ serverId: string; sessionId: string }>): SessionParentPlacement | null {
    const state = getStorage().getState();
    const key = buildSessionOrganizationServerKey(params.serverId, params.sessionId);
    const placement = readEffectiveSessionParentPlacement(
        state.sessionOrganizationAppearancesBySessionKey[key]?.display,
        state.sessionOrganizationAppearancePresentationsBySessionKey[key]?.presentation,
    );
    if (placement?.kind === 'session') {
        return { kind: 'session', parentSessionId: placement.parentSessionId };
    }
    return placement?.kind === 'topLevel' ? { kind: 'topLevel' } : null;
}

function isSameSessionParentPlacement(
    current: SessionParentPlacement | null,
    applied: SessionParentPlacement | null,
): boolean {
    if (current?.kind !== applied?.kind) return false;
    if (current?.kind !== 'session' || applied?.kind !== 'session') return current !== null && applied !== null;
    return current.parentSessionId === applied.parentSessionId;
}

function readStoredSessionParentId(params: Readonly<{ serverId: string; sessionId: string }>): string | null {
    const placement = readStoredSessionParentPlacement(params);
    return placement?.kind === 'session' ? placement.parentSessionId : null;
}

export function buildSessionParentPlacementReportingInstruction(params: Readonly<{
    placement: SessionParentPlacement;
    formerParentSessionId?: string | null;
}>): string | null {
    if (params.placement.kind === 'session') {
        return `This session is now nested under session ${params.placement.parentSessionId}. Treat that session as your reporting parent for this session's work. Report material progress, results, and blockers to it through the available supported route. Keep your current role, task instructions, permissions, and mode.`;
    }
    const formerParentSessionId = params.formerParentSessionId?.trim();
    if (!formerParentSessionId) return null;
    return `This session is now standalone. Stop treating session ${formerParentSessionId} as your reporting parent because of nesting. Keep following any separate role or task instruction that assigns a delivery Lead. Keep your current role, permissions, and mode.`;
}

/** Set/clear a session override. Errors reject after rollback and follow the organization mutation error path. */
export async function setSessionAppearance(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    sessionId: string;
}> & SessionAppearancePatch): Promise<Readonly<{
    /** Opened protected save response, independent of later store publications. */
    presentation?: SessionOrganizationSessionAppearancePresentation | null;
}>> {
    const key = buildSessionOrganizationServerKey(params.serverId, params.sessionId);
    let appliedPresentation: SessionOrganizationSessionAppearancePresentation | null | undefined;
    if (params.placement?.kind === 'session') {
        const state = getStorage().getState();
        if (!canPlaceSessionUnderParent({
            state,
            serverId: params.serverId,
            sessionId: params.sessionId,
            parentSessionId: params.placement.parentSessionId,
        })) {
            throw new Error('invalid-session-parent');
        }
    }
    const state = getStorage().getState();
    const current = state.sessionOrganizationAppearancesBySessionKey[key]?.display;
    if (params.placement !== undefined || params.identity !== undefined) {
        if (state.sessionOrganizationAppearancePresentationsSupportedByServerId[params.serverId] !== true) {
            throw new Error('session-appearance-presentation-unsupported');
        }
        const presentation = mergeSessionAppearancePresentation(
            state.sessionOrganizationAppearancePresentationsBySessionKey[key]?.presentation,
            current,
            params,
        );
        const prepared = await prepareSessionOrganizationDisplayEnvelopeForWrite({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            envelope: presentation,
        });
        const response = await setSessionAppearancePresentationApi({ ...params, request: { presentation: prepared } });
        const opened = response.presentation
            ? await openSessionOrganizationDisplayEnvelope({ credentials: params.credentials, envelope: response.presentation.presentation })
            : null;
        const openedPresentation = response.presentation && opened ? { ...response.presentation, presentation: opened } : null;
        getStorage().getState().applySessionAppearancePresentation(
            params.serverId,
            params.sessionId,
            openedPresentation,
        );
        appliedPresentation = openedPresentation;
    }
    if (params.color !== undefined) {
        const merged = mergeSessionAppearanceDisplay(current, { color: params.color });
        const appearance = merged ? { sessionId: params.sessionId, display: merged, updatedAt: Date.now() } : null;
        const recordId = getStorage().getState().setSessionAppearanceOptimistic(params.serverId, params.sessionId, appearance);
        try {
            const display = await prepareSessionOrganizationDisplayEnvelopeForWrite({ credentials: params.credentials, serverUrl: params.serverUrl, envelope: appearance?.display });
            const response = await setSessionAppearanceApi({ ...params, request: { display } });
            const opened = response.appearance ? await openSessionOrganizationDisplayEnvelope({ credentials: params.credentials, envelope: response.appearance.display }) : null;
            getStorage().getState().confirmSessionAppearanceOptimistic(recordId, params.sessionId,
                response.appearance && opened ? { ...response.appearance, display: opened } : null);
        } catch (error) {
            getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
            throw error;
        }
    }
    return appliedPresentation === undefined ? {} : { presentation: appliedPresentation };
}

/**
 * Persist the canonical sidebar placement first, then queue one child-directed reporting
 * instruction on the same server. An explicit delivery retry closes over the original request,
 * so it reuses the local id without repeating the placement write.
 */
export async function setSessionParentPlacementWithDelivery(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    sessionId: string;
    placement: SessionParentPlacement;
    localId?: string;
}>): Promise<SessionParentPlacementDeliveryResult> {
    const sessionId = String(params.sessionId ?? '').trim();
    const serverId = String(params.serverId ?? '').trim();
    if (!sessionId || !serverId) {
        return { ok: false, stage: 'placement', placement: params.placement.kind, error: 'invalid_parameters' };
    }
    const currentParentSessionId = resolveCurrentSessionParentId({ serverId, sessionId });
    if (params.placement.kind === 'session') {
        const state = getStorage().getState();
        if (!canPlaceSessionUnderParent({
            state,
            serverId,
            sessionId,
            parentSessionId: params.placement.parentSessionId,
        })) {
            return { ok: false, stage: 'placement', placement: params.placement.kind, error: 'invalid-session-parent' };
        }
        if (currentParentSessionId === params.placement.parentSessionId) {
            return { ok: true, placement: params.placement.kind, instructionLocalId: null };
        }
    } else if (currentParentSessionId === null) {
        return { ok: true, placement: params.placement.kind, instructionLocalId: null };
    }
    const formerParentSessionId = params.placement.kind === 'topLevel'
        ? readStoredSessionParentId({ serverId, sessionId })
        : null;
    let appliedPlacement: SessionParentPlacement | null = null;
    try {
        const written = await setSessionAppearance({
            credentials: params.credentials,
            serverId,
            ...(params.serverUrl ? { serverUrl: params.serverUrl } : {}),
            sessionId,
            placement: params.placement,
        });
        appliedPlacement = written.presentation?.sessionId === sessionId
            ? readEffectiveSessionParentPlacement(undefined, written.presentation.presentation)
            : null;
    } catch (error) {
        return {
            ok: false,
            stage: 'placement',
            placement: params.placement.kind,
            error: error instanceof Error ? error.message : 'session_placement_failed',
        };
    }

    if (!isSameSessionParentPlacement(appliedPlacement, params.placement)) {
        return { ok: false, stage: 'placement', placement: params.placement.kind, error: 'session_placement_not_confirmed' };
    }

    const message = buildSessionParentPlacementReportingInstruction({
        placement: params.placement,
        formerParentSessionId,
    });
    if (message === null) {
        return { ok: true, placement: params.placement.kind, instructionLocalId: null };
    }
    const request = {
        sessionId,
        serverId,
        message,
        localId: params.localId?.trim() || randomUUID(),
        requestedAction: SESSION_PLACEMENT_REPORTING_REQUESTED_ACTION,
    };
    const deliver = async (): Promise<SessionParentPlacementDeliveryResult> => {
        const currentPlacement = readStoredSessionParentPlacement({ serverId, sessionId });
        if (!isSameSessionParentPlacement(currentPlacement, appliedPlacement)) {
            return {
                ok: false,
                stage: 'not_current',
                placement: params.placement.kind,
                error: 'placement_superseded',
                instruction: { localId: request.localId, message: request.message },
            };
        }
        try {
            const sent = await sendSessionMessageWithServerScope(request);
            if (sent.ok) {
                return { ok: true, placement: params.placement.kind, instructionLocalId: request.localId };
            }
            return {
                ok: false,
                stage: 'delivery',
                placement: params.placement.kind,
                errorCode: sent.errorCode,
                error: sent.error,
                instruction: { localId: request.localId, message: request.message },
                retry: deliver,
            };
        } catch (error) {
            return {
                ok: false,
                stage: 'delivery_uncertain',
                placement: params.placement.kind,
                error: error instanceof Error ? error.message : 'delivery_outcome_uncertain',
                instruction: { localId: request.localId, message: request.message },
            };
        }
    };
    return await deliver();
}

/**
 * The single-session entry used by every surface that colours a session (row menus, the session
 * header): resolves the session server's credentials, then writes through `setSessionAppearance`.
 */
export async function setSessionAppearanceForServer(params: Readonly<{
    serverId: string | null | undefined;
    sessionId: string;
}> & SessionAppearancePatch): Promise<void> {
    const resolved = await resolveSessionOrganizationMutationScope(params.serverId ?? null);
    // Not user copy: callers surface failures through their generic error path.
    if (!resolved.ok) throw new Error(`session-appearance-scope-${resolved.reason}`);
    await setSessionAppearance({ ...params, ...resolved.scope });
}

export async function setSessionParentPlacementForServerWithDelivery(params: Readonly<{
    serverId: string;
    sessionId: string;
    placement: SessionParentPlacement;
    localId?: string;
}>): Promise<SessionParentPlacementDeliveryResult> {
    const resolved = await resolveSessionOrganizationMutationScope(params.serverId);
    if (!resolved.ok) {
        return {
            ok: false,
            stage: 'placement',
            placement: params.placement.kind,
            error: `session-appearance-scope-${resolved.reason}`,
        };
    }
    return await setSessionParentPlacementWithDelivery({ ...params, ...resolved.scope });
}
