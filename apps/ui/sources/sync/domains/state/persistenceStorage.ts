import { MMKV } from 'react-native-mmkv';

let persistedStorage: MMKV | null = null;

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function normalizeStorageScope(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
    const collapsed = sanitized.replace(/_+/g, '_');
    const clamped = collapsed.slice(0, 64);
    return clamped || null;
}

function readScopedStorageScopeFromEnv(): string | null {
    return normalizeStorageScope(process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE);
}

function buildScopedStorageId(baseId: string, scope: string | null): string {
    return scope ? `${baseId}__${scope}` : baseId;
}

export function getPersistenceStorage(): MMKV {
    if (persistedStorage) return persistedStorage;
    // Keep storage-scope bootstrap local here to avoid import-cycle TDZ hazards during Sync initialization.
    const storageScope = isWebRuntime() ? null : readScopedStorageScopeFromEnv();
    persistedStorage = storageScope ? new MMKV({ id: buildScopedStorageId('default', storageScope) }) : new MMKV();
    return persistedStorage;
}
