import { buildScopedSessionRouteHref, readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';

/** Both native/local Root params and the historical web URL use this one route decision. */
export function resolveLegacySessionDeepLinkRoute(params: Readonly<{
    sessionId: string | null;
    serverId?: unknown;
    messageId?: string | null;
    jumpChildId?: string | null;
}>): ReturnType<typeof buildScopedSessionRouteHref> | null {
    const sessionId = normalizeSessionId(params.sessionId);
    if (!sessionId) return null;
    const messageId = String(params.messageId ?? '').trim();
    const jumpChildId = String(params.jumpChildId ?? '').trim();
    return buildScopedSessionRouteHref({
        sessionId, serverId: readSessionRouteServerId(params),
        suffix: messageId ? `/message/${encodeURIComponent(messageId)}` : '',
        query: jumpChildId ? { jumpChildId } : undefined,
    });
}

export function readLegacySessionDeepLinkFromWebLocation(): ReturnType<typeof resolveLegacySessionDeepLinkRoute> {
    if (typeof window === 'undefined') return null;
    if (typeof window.location?.href !== 'string') return null;

    try {
        const current = new URL(window.location.href);
        // Legacy deep-link format: `/?id=<sessionId>` (no longer generated, but may be in old links or buggy flows).
        if (current.pathname !== '/') return null;

        return resolveLegacySessionDeepLinkRoute({
            sessionId: current.searchParams.get('id'),
            serverId: current.searchParams.get('serverId'),
            messageId: current.searchParams.get('messageId'),
            jumpChildId: current.searchParams.get('jumpChildId'),
        });
    } catch {
        return null;
    }
}
