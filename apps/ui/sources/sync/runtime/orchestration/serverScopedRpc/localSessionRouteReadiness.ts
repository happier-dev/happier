import type { Session } from '@/sync/domains/state/storageTypes';
import { CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR } from '@/sync/runtime/sessionMessageDeliveryErrors';

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

export function buildRouteHydrationOptions(serverId?: string | null): Readonly<{ forceRefresh: true; serverId?: string }> {
    const normalizedServerId = normalizeServerScopeId(serverId);
    return normalizedServerId
        ? { forceRefresh: true, serverId: normalizedServerId }
        : { forceRefresh: true };
}

export async function requireLocalSessionVisibleForRoute(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    getStoredSession: (sessionId: string) => Session | null;
    ensureSessionVisibleForMessageRoute?: EnsureSessionVisibleForMessageRoute | null;
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
            buildRouteHydrationOptions(params.serverId),
        );
        const hydrationKind = readRouteHydrationResultKind(hydration);
        if (hydrationKind && hydrationKind !== 'available') {
            throw new Error(CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR);
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

export function isCreatedSessionUnavailableLocally(error: unknown): boolean {
    return error instanceof Error && error.message === CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR;
}
