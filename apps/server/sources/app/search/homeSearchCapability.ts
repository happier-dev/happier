export type HomeSearchCapability = Readonly<{
    enabled: boolean;
    provider: 'home' | 'daemon' | null;
    reason?: 'non_plain_home' | 'index_unavailable';
}>;

/** Search is advertised only after the plain Home index is open and usable. */
export function resolveHomeSearchCapability(input: Readonly<{
    storagePolicy: string | undefined;
    indexReady: boolean;
}>): HomeSearchCapability {
    if (input.storagePolicy !== 'plaintext_only' && input.storagePolicy !== 'plain') {
        return { enabled: false, provider: 'daemon', reason: 'non_plain_home' };
    }
    if (!input.indexReady) return { enabled: false, provider: null, reason: 'index_unavailable' };
    return { enabled: true, provider: 'home' };
}
