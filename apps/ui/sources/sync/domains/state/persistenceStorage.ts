import { MMKV } from 'react-native-mmkv';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';

type PersistenceStorage = Pick<MMKV, 'set' | 'getString' | 'delete' | 'getAllKeys' | 'clearAll'>;

let persistedStorage: PersistenceStorage | null = null;
const clearedListeners = new Set<() => void>();

/** Device state projections retire together with their canonical backing storage. */
export function subscribePersistenceStorageCleared(listener: () => void): () => void {
    clearedListeners.add(listener);
    return () => { clearedListeners.delete(listener); };
}

export function clearPersistenceStorage(): void {
    getPersistenceStorage().clearAll();
    publishPersistenceStorageCleared();
}

/** The adapter (including a native boundary reset) must be cleared before publishing this fact. */
export function publishPersistenceStorageCleared(): void {
    for (const listener of clearedListeners) listener();
}

function createMemoryStorage(): PersistenceStorage {
    const values = new Map<string, boolean | string | number | ArrayBuffer>();
    return {
        set: (key, value) => { values.set(key, value); },
        getString: (key) => {
            const value = values.get(key);
            return typeof value === 'string' ? value : undefined;
        },
        delete: (key) => { values.delete(key); },
        getAllKeys: () => Array.from(values.keys()),
        clearAll: () => { values.clear(); },
    };
}

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

export function getPersistenceStorageId(): string {
    return buildScopedStorageId('default', isWebRuntime() ? null : readScopedStorageScopeFromEnv());
}

export function getPersistenceStorage(): PersistenceStorage {
    if (persistedStorage) return persistedStorage;
    if (isEmbedWindowContext()) {
        persistedStorage = createMemoryStorage();
        return persistedStorage;
    }
    // Keep storage-scope bootstrap local here to avoid import-cycle TDZ hazards during Sync initialization.
    const storageScope = isWebRuntime() ? null : readScopedStorageScopeFromEnv();
    persistedStorage = storageScope ? new MMKV({ id: getPersistenceStorageId() }) : new MMKV();
    return persistedStorage;
}

/** Hard embed retirement clears only this frame's already-created volatile adapter. */
export function clearEmbedMemoryStorage(): void {
    if (isEmbedWindowContext() && persistedStorage) clearPersistenceStorage();
}
