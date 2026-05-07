import { MMKV } from 'react-native-mmkv';

import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

const STORE_KEY = 'avatar-generation-cache-v4';
const LEGACY_WEB_STORE_KEYS = Object.freeze([
    'avatar-generation-cache-v1',
    'avatar-generation-cache-v2',
    'avatar-generation-cache-v3',
]);
const MAX_XML_ENTRIES = 96;
const MAX_RASTER_ENTRIES = 64;
const MAX_WEB_XML_CHARS = 240_000;
const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';

type CacheEntry = Readonly<{ updatedAt: number; value: string }>;
type CacheState = Readonly<{
    xmlEntries: Record<string, CacheEntry>;
    rasterEntries: Record<string, CacheEntry>;
}>;

let storage: MMKV | null = null;
let state: CacheState | null = null;
let legacyWebStoreKeysRemoved = false;

function getStorage(): MMKV | null {
    if (isWebRuntime) return null;
    if (storage) return storage;
    const storageScope = readStorageScopeFromEnv();
    storage = storageScope ? new MMKV({ id: scopedStorageId('avatar-generation', storageScope) }) : new MMKV();
    return storage;
}

function readRawState(): string | null {
    try {
        if (isWebRuntime) {
            removeLegacyWebStoreKeys();
            return globalThis.localStorage?.getItem(STORE_KEY) ?? null;
        }
        return getStorage()?.getString(STORE_KEY) ?? null;
    } catch {
        return null;
    }
}

function writeRawState(raw: string): void {
    try {
        if (isWebRuntime) {
            removeLegacyWebStoreKeys();
            globalThis.localStorage?.setItem(STORE_KEY, raw);
            return;
        }
        getStorage()?.set(STORE_KEY, raw);
    } catch {
        // Cache writes are best-effort.
    }
}

function removeLegacyWebStoreKeys(): void {
    if (legacyWebStoreKeysRemoved) return;
    legacyWebStoreKeysRemoved = true;
    const localStorage = globalThis.localStorage;
    for (const key of LEGACY_WEB_STORE_KEYS) {
        try {
            localStorage?.removeItem(key);
        } catch {
            // Cache cleanup is best-effort.
        }
    }
}

function isCacheEntry(value: unknown): value is CacheEntry {
    return Boolean(
        value
        && typeof value === 'object'
        && typeof (value as CacheEntry).updatedAt === 'number'
        && typeof (value as CacheEntry).value === 'string'
    );
}

function readEntries(value: unknown): Record<string, CacheEntry> {
    const entries: Record<string, CacheEntry> = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return entries;
    for (const [key, entry] of Object.entries(value)) {
        if (!key || !isCacheEntry(entry)) continue;
        entries[key] = entry;
    }
    return entries;
}

function hydrateState(): CacheState {
    if (state) return state;
    const raw = readRawState();
    if (!raw) {
        state = { xmlEntries: {}, rasterEntries: {} };
        return state;
    }

    try {
        const parsed = JSON.parse(raw);
        const rawState = parsed && typeof parsed === 'object'
            ? parsed as { xmlEntries?: unknown; rasterEntries?: unknown }
            : {};
        state = {
            xmlEntries: readEntries(rawState.xmlEntries),
            rasterEntries: readEntries(rawState.rasterEntries),
        };
        return state;
    } catch {
        state = { xmlEntries: {}, rasterEntries: {} };
        return state;
    }
}

function estimateEntrySize(key: string, entry: CacheEntry): number {
    return key.length + entry.value.length + 72;
}

function pruneByLimit(
    entries: Record<string, CacheEntry>,
    maxEntries: number,
    maxValueChars?: number,
): Record<string, CacheEntry> {
    const sorted = Object.entries(entries).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    const kept: Array<[string, CacheEntry]> = [];
    let totalChars = 0;
    for (const [key, entry] of sorted) {
        if (kept.length >= maxEntries) break;
        const entrySize = estimateEntrySize(key, entry);
        if (maxValueChars !== undefined && kept.length > 0 && totalChars + entrySize > maxValueChars) {
            continue;
        }
        kept.push([key, entry]);
        totalChars += entrySize;
    }
    return Object.fromEntries(kept);
}

export function readAvatarXmlFromStore(key: string): string | null {
    const current = hydrateState();
    return current.xmlEntries[key]?.value ?? null;
}

export function writeAvatarXmlToStore(key: string, xml: string): void {
    const current = hydrateState();
    state = {
        ...current,
        xmlEntries: pruneByLimit({
            ...current.xmlEntries,
            [key]: { updatedAt: Date.now(), value: xml },
        }, MAX_XML_ENTRIES, isWebRuntime ? MAX_WEB_XML_CHARS : undefined),
    };
    writeRawState(JSON.stringify(state));
}

export function readAvatarRasterFromStore(key: string): string | null {
    if (isWebRuntime) {
        removeLegacyWebStoreKeys();
        return null;
    }
    const current = hydrateState();
    return current.rasterEntries[key]?.value ?? null;
}

export function writeAvatarRasterToStore(key: string, dataUri: string): void {
    if (isWebRuntime) {
        removeLegacyWebStoreKeys();
        return;
    }
    const current = hydrateState();
    state = {
        ...current,
        rasterEntries: pruneByLimit({
            ...current.rasterEntries,
            [key]: { updatedAt: Date.now(), value: dataUri },
        }, MAX_RASTER_ENTRIES),
    };
    writeRawState(JSON.stringify(state));
}
