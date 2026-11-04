/** The credential scope already captures participating Homes/Accounts and the global/Team context. */
export function buildSessionListCollapseContextKey(view: Readonly<{
    retentionScopeKey: string;
    corpusStorage: 'active' | 'archived';
    selectedSpaceId?: string | null;
}>, effectiveLayout: string): string {
    return JSON.stringify([view.retentionScopeKey, view.corpusStorage, effectiveLayout, view.selectedSpaceId ?? null]);
}

export function buildSessionListCollapseKey(contextKey: string, groupKey: string): string {
    // Both identities may already contain JSON or Windows paths. MMKV web rejects backslashes.
    return `sessionList:${encodeURIComponent(contextKey)}:${encodeURIComponent(groupKey)}`;
}

/** Read only the pre-fix 0.3 writer; new writes use the canonical component encoding above. */
export function migrateSessionListCollapseKey(key: string): string {
    const legacy = /^sessionList:("(?:[^"\\]|\\.)*"):([\s\S]*)$/.exec(key);
    if (!legacy) return key;
    try {
        const context: unknown = JSON.parse(legacy[1]!);
        return typeof context === 'string' ? buildSessionListCollapseKey(context, legacy[2]!) : key;
    } catch { return key; }
}

/** A read projection only: old flat keys remain harmless orphans in the same device-local store. */
export function readSessionListCollapsedGroups(
    keys: Readonly<Record<string, boolean>> | null | undefined,
    contextKey: string,
): Readonly<Record<string, boolean>> {
    const prefix = buildSessionListCollapseKey(contextKey, '');
    return Object.fromEntries(Object.entries(keys ?? {})
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [decodeURIComponent(key.slice(prefix.length)), value]));
}
