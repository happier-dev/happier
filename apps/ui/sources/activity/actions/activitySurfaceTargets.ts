export const ACTIVITY_SURFACE_TARGETS = {
    openInbox: 'open-inbox',
    openPrimarySession: 'open-primary-session',
} as const;

const OPEN_SESSION_PREFIX = 'open-session:' as const;

export function createActivitySurfaceSessionTarget(sessionId: string): string {
    return `${OPEN_SESSION_PREFIX}${sessionId}`;
}

export function createActivitySurfaceSessionRoute(sessionId: string): string {
    return `/session/${encodeURIComponent(sessionId)}`;
}
