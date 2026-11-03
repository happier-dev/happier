import type { Session } from '@/sync/domains/state/storageTypes';
import { CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR } from '@/sync/runtime/sessionMessageDeliveryErrors';
import { HappyError } from '@/utils/errors/errors';

// This grace covers only server-to-client propagation after spawn has already
// succeeded. Provider startup remains owned by the spawn action.
const POST_SPAWN_SESSION_VISIBILITY_GRACE_MS = 10_000;
const POST_SPAWN_SESSION_VISIBILITY_RETRY_MS = 250;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export type EnsureSessionVisibleForMessageRoute = (
    sessionId: string,
    options?: Readonly<{ forceRefresh?: boolean; serverId?: string }>,
) => Promise<unknown>;

export function normalizeServerScopeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

export function readRouteHydrationResultKind(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const kind = (value as { kind?: unknown }).kind;
    return typeof kind === 'string' && kind.trim().length > 0 ? kind.trim() : null;
}

export function buildRouteHydrationOptions(serverId?: string | null, forceRefresh = true): Readonly<{ forceRefresh: boolean; serverId?: string }> {
    const normalizedServerId = normalizeServerScopeId(serverId);
    return normalizedServerId
        ? { forceRefresh, serverId: normalizedServerId }
        : { forceRefresh };
}

export async function requireLocalSessionVisibleForRoute(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    getStoredSession: (sessionId: string) => Session | null;
    ensureSessionVisibleForMessageRoute?: EnsureSessionVisibleForMessageRoute | null;
    forceRefresh?: boolean;
    /**
     * Consumer-specific proof required after the one authoritative hydration
     * attempt. This stays here so route consumers do not grow local polling or
     * competing readiness loops.
     */
    isLocalSessionReady?: (session: Session) => boolean;
}>): Promise<Session> {
    if (typeof params.ensureSessionVisibleForMessageRoute === 'function') {
        const hydration = await params.ensureSessionVisibleForMessageRoute(
            params.sessionId,
            buildRouteHydrationOptions(params.serverId, params.forceRefresh),
        );
        const hydrationKind = readRouteHydrationResultKind(hydration);
        if (hydrationKind && hydrationKind !== 'available') {
            const code = hydration && typeof hydration === 'object' && 'errorCode' in hydration
                && typeof hydration.errorCode === 'string' ? hydration.errorCode : undefined;
            throw new HappyError(CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR, hydrationKind === 'retryable_failure' || code === 'not_found', {
                code,
                details: hydration,
            });
        }
    }

    const session = params.getStoredSession(params.sessionId);
    if (!session) {
        throw new Error(CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR);
    }
    if (params.isLocalSessionReady && !params.isLocalSessionReady(session)) {
        throw new Error(CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR);
    }
    return session;
}

export async function requireSpawnedSessionVisibleForRoute(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    getStoredSession: (sessionId: string) => Session | null;
    ensureSessionVisibleForMessageRoute?: EnsureSessionVisibleForMessageRoute | null;
}>): Promise<Session> {
    // Hydration already owns created-row publication and freshness. Presentation
    // consumes it; follow-up mutation consumers retain their explicit refresh.
    const readiness = { ...params, forceRefresh: false };
    if (typeof params.ensureSessionVisibleForMessageRoute !== 'function') {
        return await requireLocalSessionVisibleForRoute(readiness);
    }

    const deadline = Date.now() + POST_SPAWN_SESSION_VISIBILITY_GRACE_MS;
    while (true) {
        try {
            return await requireLocalSessionVisibleForRoute(readiness);
        } catch (error) {
            if (!isCreatedSessionUnavailableLocally(error)
                || (error instanceof HappyError && !error.canTryAgain)) {
                throw error;
            }
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                throw error;
            }
            await delay(Math.min(POST_SPAWN_SESSION_VISIBILITY_RETRY_MS, remainingMs));
        }
    }
}

export function isCreatedSessionUnavailableLocally(error: unknown): boolean {
    return error instanceof Error && error.message === CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR;
}
