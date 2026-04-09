type LegacySessionDeepLink = Readonly<{
    sessionId: string;
    cleanedRelativeUrl: string;
}>;

type ConsumeLegacySessionDeepLinkFromWebLocationOptions = Readonly<{
    isAuthenticated: boolean;
    navigateToRoute: (route: string) => void;
    replaceRelativeUrl: (nextRelativeUrl: string) => void;
}>;

function readLegacySessionDeepLinkFromWebLocation(): LegacySessionDeepLink | null {
    if (typeof window === 'undefined') return null;
    if (typeof window.location?.href !== 'string') return null;

    try {
        const current = new URL(window.location.href);
        // Legacy deep-link format: `/?id=<sessionId>` (no longer generated, but may be in old links or buggy flows).
        if (current.pathname !== '/') return null;

        const rawSessionId = (current.searchParams.get('id') ?? '').trim();
        if (!rawSessionId) return null;

        current.searchParams.delete('id');
        const search = current.searchParams.toString();
        const cleanedRelativeUrl = `${current.pathname}${search ? `?${search}` : ''}${current.hash ?? ''}`;
        return { sessionId: rawSessionId, cleanedRelativeUrl };
    } catch {
        return null;
    }
}

export function consumeLegacySessionDeepLinkFromWebLocation(
    options: ConsumeLegacySessionDeepLinkFromWebLocationOptions,
): boolean {
    if (!options.isAuthenticated) return false;

    const legacy = readLegacySessionDeepLinkFromWebLocation();
    if (!legacy) return false;

    options.replaceRelativeUrl(legacy.cleanedRelativeUrl);
    options.navigateToRoute(`/session/${encodeURIComponent(legacy.sessionId)}`);
    return true;
}
