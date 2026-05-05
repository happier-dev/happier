export const ACTIVITY_SURFACE_TARGETS = {
    openInbox: 'open-inbox',
    openPrimarySession: 'open-primary-session',
} as const;

const OPEN_SESSION_PREFIX = 'open-session:' as const;

export type ActivitySurfaceSessionTargetIdentity = Readonly<{
    sessionId: string;
    serverId: string | null;
}>;

function decodeTargetComponent(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function readServerIdFromTargetQuery(query: string): string | null {
    for (const part of query.split('&')) {
        const [encodedKey = '', encodedValue = ''] = part.split('=');
        if (decodeTargetComponent(encodedKey).trim() !== 'serverId') {
            continue;
        }

        const serverId = decodeTargetComponent(encodedValue).trim();
        return serverId.length > 0 ? serverId : null;
    }

    return null;
}

export function parseActivitySurfaceSessionTarget(target: string): ActivitySurfaceSessionTargetIdentity | null {
    if (!target.startsWith(OPEN_SESSION_PREFIX)) {
        return null;
    }

    const payload = target.slice(OPEN_SESSION_PREFIX.length).trim();
    if (!payload) {
        return null;
    }

    const queryStartIndex = payload.indexOf('?');
    const encodedSessionId = queryStartIndex >= 0 ? payload.slice(0, queryStartIndex) : payload;
    const sessionId = decodeTargetComponent(encodedSessionId).trim();
    if (!sessionId) {
        return null;
    }

    const query = queryStartIndex >= 0 ? payload.slice(queryStartIndex + 1) : '';
    const serverId = query ? readServerIdFromTargetQuery(query) : null;

    return {
        sessionId,
        serverId,
    };
}

export function createActivitySurfaceSessionTarget(
    sessionId: string,
    serverId?: string | null,
): string {
    const target = `${OPEN_SESSION_PREFIX}${encodeURIComponent(sessionId)}`;
    const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
    if (!normalizedServerId) {
        return target;
    }
    return `${target}?serverId=${encodeURIComponent(normalizedServerId)}`;
}

export function createActivitySurfaceSessionRoute(
    sessionId: string,
    serverId?: string | null,
): string {
    const route = `/session/${encodeURIComponent(sessionId)}`;
    const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
    if (!normalizedServerId) {
        return route;
    }
    return `${route}?serverId=${encodeURIComponent(normalizedServerId)}`;
}
