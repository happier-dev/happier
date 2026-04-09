import { LruMap } from '@/utils/cache/lruMap';
import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

export type SessionListOrderingPersistenceState = Readonly<{
    pinnedKeyList: string[];
    pinnedKeySet: ReadonlySet<string>;
    currentGroupOrderMap: Record<string, string[]>;
}>;

const EMPTY_PINNED_SESSION_KEYS: string[] = [];
const EMPTY_SESSION_LIST_GROUP_ORDER_MAP: Record<string, string[]> = {};
const EMPTY_PINNED_KEY_SET: ReadonlySet<string> = new Set();

const SESSION_LIST_ORDERING_PERSISTENCE_STATE_CACHE = new LruMap<string, SessionListOrderingPersistenceState>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

export function resolveSessionListOrderingPersistenceState(input: Readonly<{
    pinnedSessionKeysV1: string[] | null | undefined;
    sessionListGroupOrderV1: Record<string, string[]> | null | undefined;
}>): SessionListOrderingPersistenceState {
    const pinnedKeyList = Array.isArray(input.pinnedSessionKeysV1) && input.pinnedSessionKeysV1.length > 0
        ? input.pinnedSessionKeysV1
        : EMPTY_PINNED_SESSION_KEYS;
    const currentGroupOrderMap = input.sessionListGroupOrderV1 != null && Object.keys(input.sessionListGroupOrderV1).length > 0
        ? input.sessionListGroupOrderV1
        : EMPTY_SESSION_LIST_GROUP_ORDER_MAP;

    const cacheKey = JSON.stringify([
        pinnedKeyList,
        currentGroupOrderMap,
    ]);
    const cached = SESSION_LIST_ORDERING_PERSISTENCE_STATE_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const next = {
        pinnedKeyList,
        pinnedKeySet: pinnedKeyList.length === 0 ? EMPTY_PINNED_KEY_SET : new Set(pinnedKeyList),
        currentGroupOrderMap,
    };

    SESSION_LIST_ORDERING_PERSISTENCE_STATE_CACHE.set(cacheKey, next);
    return next;
}
