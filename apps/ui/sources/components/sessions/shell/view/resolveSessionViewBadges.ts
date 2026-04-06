const EMPTY_SESSION_VIEW_BADGES: ReadonlyArray<string> = [];
const SESSION_VIEW_BADGES_CACHE = new Map<string, ReadonlyArray<string>>();

export function resolveSessionViewBadges(input: Readonly<{
    storageBadge: string;
    providerBadge: string | null;
}>): ReadonlyArray<string> {
    const cacheKey = [input.storageBadge, input.providerBadge ?? ''].join('|');
    const cached = SESSION_VIEW_BADGES_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const next = input.providerBadge ? [input.storageBadge, input.providerBadge] : [input.storageBadge];
    if (next.length === 0) {
        return EMPTY_SESSION_VIEW_BADGES;
    }

    SESSION_VIEW_BADGES_CACHE.set(cacheKey, next);
    return next;
}
