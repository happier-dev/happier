import type { SessionAuthSurfaceState } from '@/components/sessions/shell/sessionAuthSurfaceState';
import { resolveSessionAuthSurfaceState } from '@/components/sessions/shell/sessionAuthSurfaceState';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { createSessionRouteServerScope } from './sessionRouteServerScope';

type SessionRouteAuthRecoverySyncError = Readonly<{
    message: string;
    kind: 'auth' | 'config' | 'network' | 'server' | 'unknown';
    serverId?: string | null;
}> | null;

type SessionRouteParams = Readonly<Record<string, string | string[] | undefined>> | null | undefined;

export type SessionRouteAuthRecoveryState = Readonly<{
    sessionId: string;
    baseHref: string | null;
    currentRouteServerId: string | null;
    authSurfaceState: SessionAuthSurfaceState | null;
}>;

function normalizeServerId(value: string | null | undefined): string | null {
    const trimmed = String(value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizePathname(pathname: string | null | undefined): string {
    return String(pathname ?? '').trim();
}

function readHrefPathname(href: string | null | undefined): string {
    return normalizePathname(String(href ?? '').split('?')[0] ?? '');
}

export function resolveSessionRouteAuthRecoveryState(params: Readonly<{
    routeParams: SessionRouteParams;
    activeServerId: string | null | undefined;
    endpointStatus: unknown;
    syncError: SessionRouteAuthRecoverySyncError;
}>): SessionRouteAuthRecoveryState {
    const routeScope = createSessionRouteServerScope(params.routeParams);
    const sessionId = normalizeSessionId(params.routeParams?.id);
    const currentRouteServerId = routeScope.serverId ?? normalizeServerId(params.activeServerId);
    const scopedSyncError = selectSyncErrorForServer(params.syncError, currentRouteServerId);
    const effectiveEndpointStatus = currentRouteServerId === normalizeServerId(params.activeServerId)
        ? params.endpointStatus
        : 'idle';

    return {
        sessionId,
        baseHref: sessionId ? routeScope.buildHref(sessionId) : null,
        currentRouteServerId,
        authSurfaceState: resolveSessionAuthSurfaceState({
            endpointStatus: effectiveEndpointStatus,
            syncError: scopedSyncError,
        }),
    };
}

export function isSessionRouteInAuthRecoverySubtree(params: Readonly<{
    pathname: string | null | undefined;
    authRecovery: SessionRouteAuthRecoveryState;
}>): boolean {
    const pathname = normalizePathname(params.pathname);
    const basePathname = readHrefPathname(params.authRecovery.baseHref);
    if (!basePathname || !params.authRecovery.authSurfaceState) {
        return false;
    }
    return pathname === basePathname || pathname.startsWith(`${basePathname}/`);
}

export function shouldNormalizeSessionRouteToAuthRecoveryBase(params: Readonly<{
    pathname: string | null | undefined;
    authRecovery: SessionRouteAuthRecoveryState;
}>): boolean {
    const pathname = normalizePathname(params.pathname);
    const basePathname = readHrefPathname(params.authRecovery.baseHref);
    if (!basePathname || !params.authRecovery.authSurfaceState) {
        return false;
    }
    return pathname.startsWith(`${basePathname}/`);
}
