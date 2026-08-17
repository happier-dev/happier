/**
 * Single owner for the opaque per-token component of scoped data-key cache keys.
 *
 * The raw bearer token must not appear in a cache key (it leaks into error and debug
 * output), and hashing it invites cross-token cache reuse on collision. So each distinct
 * token is mapped to a random opaque id, kept in a bounded LRU.
 *
 * The machine transport and session data-key caches both need this and previously carried
 * verbatim copies of it; one registry keeps a token's identity stable across both.
 */
const tokenCacheKeyByToken = new Map<string, string>();

function createOpaqueTokenKey(): string {
    const cryptoAny = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    return typeof cryptoAny?.randomUUID === 'function'
        ? cryptoAny.randomUUID()
        : `tk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function getOrCreateScopedCacheTokenKey(token: string, maxEntries: number): string {
    const existing = tokenCacheKeyByToken.get(token);
    if (existing) {
        // Refresh LRU ordering.
        tokenCacheKeyByToken.delete(token);
        tokenCacheKeyByToken.set(token, existing);
        return existing;
    }

    const key = createOpaqueTokenKey();
    tokenCacheKeyByToken.set(token, key);

    const max = Math.max(1, Math.trunc(maxEntries));
    while (tokenCacheKeyByToken.size > max) {
        const oldest = tokenCacheKeyByToken.keys().next();
        if (oldest.done) break;
        tokenCacheKeyByToken.delete(oldest.value);
    }
    return key;
}

export function resetScopedCacheTokenKeysForTests(): void {
    tokenCacheKeyByToken.clear();
}
