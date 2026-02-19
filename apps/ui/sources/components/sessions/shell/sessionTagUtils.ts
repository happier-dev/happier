export function sessionTagKey(serverId: string, sessionId: string): string {
    return `${serverId}:${sessionId}`;
}

export function getTagsForSession(
    sessionTagsV1: Record<string, string[]> | null | undefined,
    key: string,
): string[] {
    return sessionTagsV1?.[key] ?? [];
}

export function getAllKnownTags(
    sessionTagsV1: Record<string, string[]> | null | undefined,
): string[] {
    if (!sessionTagsV1) return [];
    const all = new Set<string>();
    for (const tags of Object.values(sessionTagsV1)) {
        for (const tag of tags) all.add(tag);
    }
    return Array.from(all).sort();
}

export function setTagsForSession(
    prev: Record<string, string[]> | null | undefined,
    key: string,
    newTags: string[],
): Record<string, string[]> {
    const next = { ...(prev ?? {}) };
    if (newTags.length === 0) {
        delete next[key];
    } else {
        next[key] = newTags;
    }
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
