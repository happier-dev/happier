export const ACTIVITY_SURFACE_TARGETS = {
    openInbox: 'open-inbox',
    openPrimarySession: 'open-primary-session',
    openSessionPrefix: 'open-session:',
} as const;

export function createActivitySurfaceSessionRoute(sessionId: string): string {
    return `/session/${encodeURIComponent(sessionId)}`;
}
