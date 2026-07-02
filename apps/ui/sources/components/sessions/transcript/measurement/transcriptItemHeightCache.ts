import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { LruMap } from '@/utils/cache/lruMap';

export type TranscriptItemHeightRowState =
    | 'stable'
    | 'streaming'
    | 'thinking'
    | 'pending-action'
    | 'tool-progress';

export type TranscriptItemHeightValiditySignature = Readonly<{
    itemId: string;
    kind: string;
    structuralKey: string;
    widthBucket: string;
    fontScaleKey: string;
    groupingMode: string;
    forkContextKey: string;
    expansionKey: string;
    rowState: TranscriptItemHeightRowState;
}>;

export type TranscriptItemHeightCacheEntry = Readonly<{
    heightPx: number;
}>;

export type TranscriptItemHeightCache = Readonly<{
    get(signature: TranscriptItemHeightValiditySignature): TranscriptItemHeightCacheEntry | undefined;
    set(signature: TranscriptItemHeightValiditySignature, entry: TranscriptItemHeightCacheEntry): boolean;
    clear(): void;
    size(): number;
}>;

export type TranscriptItemHeightCacheOptions = Readonly<{
    maxEntries?: number;
}>;

export function buildTranscriptItemHeightSignatureKey(
    signature: TranscriptItemHeightValiditySignature,
): string {
    return `${signature.itemId.length}:${signature.itemId}|` +
        `${signature.kind.length}:${signature.kind}|` +
        `${signature.structuralKey.length}:${signature.structuralKey}|` +
        `${signature.widthBucket.length}:${signature.widthBucket}|` +
        `${signature.fontScaleKey.length}:${signature.fontScaleKey}|` +
        `${signature.groupingMode.length}:${signature.groupingMode}|` +
        `${signature.forkContextKey.length}:${signature.forkContextKey}|` +
        `${signature.expansionKey.length}:${signature.expansionKey}|` +
        `${signature.rowState.length}:${signature.rowState}|`;
}

export function isTranscriptItemHeightSignatureStable(
    signature: TranscriptItemHeightValiditySignature,
): boolean {
    return (
        signature.rowState === 'stable' &&
        hasText(signature.itemId) &&
        hasText(signature.kind) &&
        hasText(signature.structuralKey) &&
        hasText(signature.widthBucket) &&
        hasText(signature.fontScaleKey) &&
        hasText(signature.groupingMode) &&
        hasText(signature.forkContextKey) &&
        hasText(signature.expansionKey)
    );
}

export function createDefaultTranscriptItemHeightCache(
    options: TranscriptItemHeightCacheOptions = {},
): TranscriptItemHeightCache {
    const maxEntries = options.maxEntries ?? loadSyncTuning().transcriptItemHeightCacheMaxEntries;
    const entries = new LruMap<string, TranscriptItemHeightCacheEntry>({ maxEntries });

    return {
        get(signature) {
            if (!isTranscriptItemHeightSignatureStable(signature)) return undefined;
            return entries.get(buildTranscriptItemHeightSignatureKey(signature));
        },
        set(signature, entry) {
            if (!isTranscriptItemHeightSignatureStable(signature)) return false;
            if (!isValidHeight(entry.heightPx)) return false;
            entries.set(buildTranscriptItemHeightSignatureKey(signature), {
                heightPx: entry.heightPx,
            });
            return true;
        },
        clear() {
            entries.clear();
        },
        size() {
            return entries.size;
        },
    };
}

export function createTestTranscriptItemHeightCache(
    options?: TranscriptItemHeightCacheOptions,
): TranscriptItemHeightCache {
    return createDefaultTranscriptItemHeightCache(options);
}

let defaultCacheInstance: TranscriptItemHeightCache | null = null;

export function getDefaultTranscriptItemHeightCache(
    options?: TranscriptItemHeightCacheOptions,
): TranscriptItemHeightCache {
    if (defaultCacheInstance === null) {
        defaultCacheInstance = createDefaultTranscriptItemHeightCache(options);
    }
    return defaultCacheInstance;
}

export function __resetDefaultTranscriptItemHeightCacheForTests(): void {
    defaultCacheInstance?.clear();
    defaultCacheInstance = null;
}

function hasText(value: string): boolean {
    return value.length > 0;
}

function isValidHeight(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}
