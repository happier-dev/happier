import { resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { getAgentModelConfig } from '@happier-dev/agents';
import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import {
    buildOutgoingUserTextRecord,
    projectLocalOutboundUserMessage,
} from '@/sync/domains/messages/outgoingUserMessage';
import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { storage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { sync } from '@/sync/sync';
import {
    isCreatedSessionUnavailableLocally,
    requireSpawnedSessionVisibleForRoute,
} from '@/sync/runtime/orchestration/serverScopedRpc/localSessionRouteReadiness';

type CreatedNewSessionRouter = Readonly<{
    replace(path: unknown, options?: unknown): void;
}>;

export type PresentCreatedNewSessionResult = 'opened' | 'inactive' | 'unavailable';

export function projectAcceptedNewSessionFirstTurn(params: Readonly<{
    sessionId: string;
    localId: string;
    text: string;
    fallbackAgentId?: string | null;
    fallbackPermissionMode?: PermissionMode | null;
    fallbackModelMode?: ModelMode | null;
}>): void {
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
    if (session) {
        storage.getState().markSessionOptimisticThinking(params.sessionId);
    }
    projectLocalOutboundUserMessage({
        sessionId: params.sessionId,
        localId: params.localId,
        text: params.text,
        displayText: params.text,
        rawRecord,
        deliveryStatus: 'accepted',
    });
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
    href?: string | null;
    isStillActive?: () => boolean;
    prepareDestination?: () => void;
    operation?: QualifiedActionOperation;
}>): Promise<PresentCreatedNewSessionResult> {
    const accountCurrentness = captureActiveServerAccountScopeCurrentness();
    try {
        await requireSpawnedSessionVisibleForRoute({
            sessionId: params.sessionId,
            serverId: params.serverId,
            getStoredSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
            ensureSessionVisibleForMessageRoute: typeof sync.ensureSessionVisibleForMessageRoute === 'function'
                ? sync.ensureSessionVisibleForMessageRoute
                : null,
        });
    } catch (error) {
        if (isCreatedSessionUnavailableLocally(error)) {
            return 'unavailable';
        }
        throw error;
    }

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
    });
    actionOperationPresentationCoordinator.acknowledgeRequestPresented({
        serverId: params.serverId,
        accountId: params.accountId,
        requestId: params.requestId,
    }, params.operation);
    return 'opened';
}
