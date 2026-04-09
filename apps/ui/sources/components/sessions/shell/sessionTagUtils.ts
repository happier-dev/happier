import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

const EMPTY_SESSION_TAGS: string[] = [];
const EMPTY_SESSION_TAGS_BY_KEY: Record<string, string[]> = {};

const ALL_KNOWN_TAGS_CACHE = new LruMap<string, string[]>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

export type SessionItemTagCollections = Readonly<{
    activeTags: ReadonlyArray<string>;
    knownTags: ReadonlyArray<string>;
}>;

const EMPTY_SESSION_ITEM_TAG_COLLECTIONS: SessionItemTagCollections = Object.freeze({
    activeTags: EMPTY_SESSION_TAGS,
    knownTags: EMPTY_SESSION_TAGS,
});

function areTagsEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

export function sessionTagKey(serverId: string, sessionId: string): string {
    return `${serverId}:${sessionId}`;
}

export function getTagsForSession(
    sessionTagsV1: Record<string, string[]> | null | undefined,
    key: string,
): string[] {
    return sessionTagsV1?.[key] ?? EMPTY_SESSION_TAGS;
}

export function getAllKnownTags(
    sessionTagsV1: Record<string, string[]> | null | undefined,
): string[] {
    if (!sessionTagsV1) return EMPTY_SESSION_TAGS;
    const all = new Set<string>();
    for (const tags of Object.values(sessionTagsV1)) {
        for (const tag of tags) all.add(tag);
    }
    if (all.size === 0) return EMPTY_SESSION_TAGS;
    const knownTags = Array.from(all).sort();
    const cacheKey = JSON.stringify(knownTags);
    const cachedKnownTags = ALL_KNOWN_TAGS_CACHE.get(cacheKey);
    if (cachedKnownTags) return cachedKnownTags;
    ALL_KNOWN_TAGS_CACHE.set(cacheKey, knownTags);
    return knownTags;
}

export function setTagsForSession(
    prev: Record<string, string[]> | null | undefined,
    key: string,
    newTags: string[],
): Record<string, string[]> {
    if (newTags.length === 0) {
        if (prev == null) return EMPTY_SESSION_TAGS_BY_KEY;
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
    }

    const currentTags = prev?.[key];
    if (currentTags != null && areTagsEqual(currentTags, newTags)) {
        return prev ?? EMPTY_SESSION_TAGS_BY_KEY;
    }

    const next = { ...(prev ?? {}) };
    next[key] = newTags;
    return next;
}

export function toggleTagForSession(
    prev: Record<string, string[]> | null | undefined,
    key: string,
    tag: string,
): Record<string, string[]> {
    const current = getTagsForSession(prev, key);
    const next = current.includes(tag)
        ? current.filter((t) => t !== tag)
        : [...current, tag];
    return setTagsForSession(prev, key, next);
}

export function resolveSessionItemTagCollections(input: Readonly<{
    tags?: ReadonlyArray<string> | null;
    allKnownTags?: ReadonlyArray<string> | null;
}>): SessionItemTagCollections {
    const activeTags = input.tags != null && input.tags.length > 0 ? input.tags : EMPTY_SESSION_TAGS;
    const knownTags = input.allKnownTags != null && input.allKnownTags.length > 0 ? input.allKnownTags : EMPTY_SESSION_TAGS;
    if (activeTags === EMPTY_SESSION_TAGS && knownTags === EMPTY_SESSION_TAGS) {
        return EMPTY_SESSION_ITEM_TAG_COLLECTIONS;
    }
    return {
        activeTags,
        knownTags,
    };
}
