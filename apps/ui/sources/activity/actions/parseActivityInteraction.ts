import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';

import { normalizeServerUrl } from '@/sync/domains/server/activeServerSwitch';
import { coerceRelativeRoute } from '@/utils/path/routeUtils';

import type { ParsedActivityInteraction } from './activityActionTypes';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSessionId(data: unknown): string {
    if (!isRecord(data)) return '';
    return typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
}

function readPrimarySessionId(data: unknown): string {
    if (!isRecord(data)) return '';
    return typeof data.primarySessionId === 'string' ? data.primarySessionId.trim() : '';
}

function readRequestId(data: unknown): string {
    if (!isRecord(data)) return '';
    if (typeof data.requestId === 'string') return data.requestId.trim();
    if (typeof data.permissionId === 'string') return data.permissionId.trim();
    return '';
}

function resolveRoute(data: unknown): string | null {
    if (!isRecord(data)) return null;
    if (typeof data.url === 'string' && data.url.trim()) {
        return coerceRelativeRoute(data.url);
    }
    const sessionId = readSessionId(data);
    return sessionId ? `/session/${encodeURIComponent(sessionId)}` : null;
}

function resolveServerUrl(data: unknown): string | null {
    if (!isRecord(data)) return null;
    const raw =
        typeof data.serverUrl === 'string'
            ? data.serverUrl
            : typeof data.server === 'string'
                ? data.server
                : '';
    const normalized = normalizeServerUrl(raw);
    return normalized ? normalized : null;
}

function resolveActivitySurfaceRoute(actionIdentifier: string, data: unknown): string | null {
    if (actionIdentifier === 'open-inbox') {
        return '/inbox';
    }

    if (actionIdentifier === 'open-primary-session') {
        const primarySessionId = readPrimarySessionId(data) || readSessionId(data);
        return primarySessionId ? `/session/${encodeURIComponent(primarySessionId)}` : '/inbox';
    }

    if (actionIdentifier.startsWith('open-session:')) {
        const sessionId = actionIdentifier.slice('open-session:'.length).trim();
        return sessionId ? `/session/${encodeURIComponent(sessionId)}` : null;
    }

    return null;
}

export function parseActivityInteraction(params: Readonly<{
    actionIdentifier: string;
    defaultActionIdentifier: string;
    data: unknown;
}>): ParsedActivityInteraction | null {
    const actionIdentifier = params.actionIdentifier.trim() || params.defaultActionIdentifier;
    const isDefaultTap = actionIdentifier === params.defaultActionIdentifier;
    const permissionAction =
        actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1
            ? ('allow' as const)
            : actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1
                ? ('deny' as const)
                : null;
    const activitySurfaceRoute = resolveActivitySurfaceRoute(actionIdentifier, params.data);

    const isOpenAction =
        isDefaultTap
        || actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1
        || activitySurfaceRoute !== null;
    if (!isOpenAction && permissionAction === null) {
        return null;
    }

    const sessionId = readSessionId(params.data);
    const requestId = readRequestId(params.data);
    const route = activitySurfaceRoute ?? resolveRoute(params.data);
    const resolvedPermissionAction =
        permissionAction && sessionId && requestId
            ? {
                action: permissionAction,
                sessionId,
                requestId,
            }
            : null;

    if (!route && resolvedPermissionAction === null) {
        return null;
    }

    return {
        actionIdentifier,
        isDefaultTap,
        isOpenAction,
        route,
        serverUrl: resolveServerUrl(params.data),
        permissionAction: resolvedPermissionAction,
    };
}
