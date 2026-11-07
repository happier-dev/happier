import { resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { getAgentModelConfig } from '@happier-dev/agents';
import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import {
    buildOutgoingUserTextRecord,
    clearLocalOutboundUserMessage,
    projectLocalOutboundUserMessage,
} from '@/sync/domains/messages/outgoingUserMessage';
import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { storage } from '@/sync/domains/state/storage';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { sync } from '@/sync/sync';
import { requireSpawnedSessionVisibleForRoute } from '@/sync/runtime/orchestration/serverScopedRpc/localSessionRouteReadiness';

type CreatedNewSessionRouter = Readonly<{
    replace(path: unknown, options?: unknown): void;
}>;

export type PresentCreatedNewSessionResult = 'opened' | 'inactive' | 'unavailable';

type NewSessionFirstTurnProjection = Readonly<{
    sessionId: string;
    localId: string;
    text: string;
    fallbackAgentId?: string | null;
    fallbackPermissionMode?: PermissionMode | null;
    fallbackModelMode?: ModelMode | null;
}>;

function projectNewSessionFirstTurn(params: NewSessionFirstTurnProjection & Readonly<{ accepted: boolean }>): void {
    const state = storage.getState();
    const session = state.sessions[params.sessionId] ?? null;
    const sessionAgentId = resolveAgentIdFromFlavor(session?.metadata?.flavor ?? null);
    const agentId = sessionAgentId ?? params.fallbackAgentId ?? null;
    const modelMode = session?.modelMode
        || params.fallbackModelMode
        || (agentId ? getAgentModelConfig(agentId)?.defaultMode : null)
        || 'default';
    const permissionMode = session?.permissionMode || params.fallbackPermissionMode || 'default';
    const rawRecord = buildOutgoingUserTextRecord({
        text: params.text,
        displayText: params.text,
        agentId,
        permissionMode,
        modelMode,
        settings: state.settings,
        session,
    });
    // Only an accepted first input may claim the agent is working on it.
    if (session && params.accepted) {
        storage.getState().markSessionOptimisticThinking(params.sessionId);
    }
    projectLocalOutboundUserMessage({
        sessionId: params.sessionId,
        localId: params.localId,
        text: params.text,
        displayText: params.text,
        rawRecord,
        ...(params.accepted ? { deliveryStatus: 'accepted' as const } : { pendingLaunch: { state: 'starting' as const } }),
    });
}

export function projectAcceptedNewSessionFirstTurn(params: NewSessionFirstTurnProjection): void {
    projectNewSessionFirstTurn({ ...params, accepted: true });
}

/**
 * The Session is committed but its launch still owns the first input: paint it unconfirmed, owned by
 * the launch (no Message writer acts on it), and never claim the agent accepted it.
 */
export function projectLaunchingNewSessionFirstTurn(params: NewSessionFirstTurnProjection): void {
    projectNewSessionFirstTurn({ ...params, accepted: false });
}

/**
 * Settles a presented launch's first message without a terminal acceptance: `failed` keeps the text
 * with the typed reason; `unresolved` says the outcome is unknown (its committed twin still retires it).
 */
export function settleNewSessionFirstTurnLaunch(params: Readonly<{
    sessionId: string;
    localId: string;
    settlement: Exclude<NonNullable<PendingMessage['pendingLaunch']>, Readonly<{ state: 'starting' }>>;
}>): void {
    const row = storage.getState().sessionPending[params.sessionId]?.messages
        .find(message => message.localId === params.localId && message.pendingLaunch !== undefined);
    if (!row) return;
    storage.getState().upsertPendingMessage(params.sessionId, { ...row, pendingLaunch: params.settlement });
}

/** The launch handed its first input to another owner (for example the Session's own composer draft). */
export function clearLaunchingNewSessionFirstTurn(params: Readonly<{ sessionId: string; localId: string }>): void {
    const row = storage.getState().sessionPending[params.sessionId]?.messages
        .find(message => message.localId === params.localId && message.pendingLaunch !== undefined);
    if (row) clearLocalOutboundUserMessage(params);
}

/**
 * Owns the visual custody handoff from New Session to the created session.
 * The source surface remains intact until the destination can render, and any
 * accepted first-turn projection is installed in that same crossover frame.
 */
export async function presentCreatedNewSession(params: Readonly<{
    sessionId: string;
    serverId: string;
    accountId: string;
    requestId: string;
    router: CreatedNewSessionRouter;
    /** A Docked composer goes to the Session instead of presenting it in place. */
    opensDestination?: boolean;
    href?: string | null;
    isStillActive?: () => boolean;
    prepareDestination?: () => void;
    operation?: QualifiedActionOperation;
}>): Promise<PresentCreatedNewSessionResult> {
    const accountCurrentness = captureActiveServerAccountScopeCurrentness();
    await requireSpawnedSessionVisibleForRoute({
        sessionId: params.sessionId,
        serverId: params.serverId,
        getStoredSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
        ensureSessionVisibleForMessageRoute: typeof sync.ensureSessionVisibleForMessageRoute === 'function'
            ? sync.ensureSessionVisibleForMessageRoute
            : null,
    });

    if (!accountCurrentness.isCurrent() || (params.isStillActive && !params.isStillActive())) {
        return 'inactive';
    }

    params.prepareDestination?.();
    params.router.replace(params.href ?? buildScopedSessionRouteHref({
        sessionId: params.sessionId,
        serverId: params.serverId,
    }), {
        dangerouslySingular() {
            return 'session';
        },
        ...(params.opensDestination ? { opensDestination: true } : {}),
    });
    actionOperationPresentationCoordinator.acknowledgeRequestPresented({
        serverId: params.serverId,
        accountId: params.accountId,
        requestId: params.requestId,
    }, params.operation);
    return 'opened';
}
