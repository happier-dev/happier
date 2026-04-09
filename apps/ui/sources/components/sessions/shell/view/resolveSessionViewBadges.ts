import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from '../sessionListShellCacheConfig';

const SESSION_VIEW_BADGES_CACHE = new LruMap<string, ReadonlyArray<string>>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

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
    SESSION_VIEW_BADGES_CACHE.set(cacheKey, next);
    return next;
}
