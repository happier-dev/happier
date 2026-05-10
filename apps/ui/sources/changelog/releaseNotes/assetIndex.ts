import {
    parseReleaseNotesAssetIndex,
} from './schema';
import {
    emitReleaseNotesRuntimeChanged,
    getCachedAssetIndexRaw,
    setCachedAssetIndexRaw,
} from './storage';
import bundledAssetIndexRaw from './asset-index.generated.json';
import type { ReleaseNotesAssetIndex, ReleaseNotesAssetIndexEntry } from './types';

let cachedIndex: ReleaseNotesAssetIndex | null | undefined = undefined;

function parseRawAssetIndex(rawJsonText: string): ReleaseNotesAssetIndex | null {
    try {
        return parseReleaseNotesAssetIndex(JSON.parse(rawJsonText));
    } catch {
        return null;
    }
}

function loadInitialAssetIndex(): ReleaseNotesAssetIndex | null {
    const cachedRaw = getCachedAssetIndexRaw();
    if (cachedRaw) {
        const parsed = parseRawAssetIndex(cachedRaw);
        if (parsed) return parsed;
    }
    return parseReleaseNotesAssetIndex(bundledAssetIndexRaw);
}

export function setAssetIndex(raw: unknown): ReleaseNotesAssetIndex | null {
    const parsed = parseReleaseNotesAssetIndex(raw);
    if (parsed) {
        cachedIndex = parsed;
        emitReleaseNotesRuntimeChanged();
    }
    return parsed;
}

export function getAssetIndex(): ReleaseNotesAssetIndex | null {
    if (cachedIndex === undefined) {
        cachedIndex = loadInitialAssetIndex();
    }
    return cachedIndex;
}

export function commitRemoteAssetIndex(rawJsonText: string): ReleaseNotesAssetIndex | null {
    const parsed = parseRawAssetIndex(rawJsonText);
    if (!parsed) {
        return null;
    }
    setCachedAssetIndexRaw(rawJsonText);
    cachedIndex = parsed;
    emitReleaseNotesRuntimeChanged();
    return parsed;
}

export function lookupAsset(key: string): ReleaseNotesAssetIndexEntry | null {
    const index = getAssetIndex();
    if (!index) return null;
    return index.assets[key] ?? null;
}

export function resetAssetIndexForTests(): void {
    cachedIndex = undefined;
}
