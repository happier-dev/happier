import { z } from 'zod';

import type { RemoteHostId } from '@/sync/domains/remoteHosts/remoteHostModel';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

export type RemoteHostLocalOverrides = Readonly<{
    identityFilePath?: string | null;
    sshConfigFilePath?: string | null;
}>;

export type RemoteHostLocalOverridesById = Readonly<Record<RemoteHostId, RemoteHostLocalOverrides>>;

export type RemoteHostLocalOverridesStore = Readonly<{
    readAll: () => RemoteHostLocalOverridesById;
    get: (remoteHostId: RemoteHostId) => RemoteHostLocalOverrides | null;
    set: (remoteHostId: RemoteHostId, overrides: RemoteHostLocalOverrides) => void;
    patch: (remoteHostId: RemoteHostId, delta: Partial<RemoteHostLocalOverrides>) => void;
    delete: (remoteHostId: RemoteHostId) => void;
}>;

type KeyValueStringStorage = Readonly<{
    getString: (key: string) => string | null;
    set: (key: string, value: string) => void;
    delete: (key: string) => void;
}>;

export const REMOTE_HOST_LOCAL_OVERRIDES_PERSIST_KEY = 'remote-host-local-overrides-v1';

const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';

const RemoteHostLocalOverridesSchema = z.object({
    identityFilePath: z.string().nullable().optional(),
    sshConfigFilePath: z.string().nullable().optional(),
}).strict();

const PersistedRemoteHostLocalOverridesSchema = z.object({
    version: z.literal(1),
    overridesById: z.record(z.string(), RemoteHostLocalOverridesSchema),
}).strict();

type PersistedRemoteHostLocalOverrides = z.infer<typeof PersistedRemoteHostLocalOverridesSchema>;

function parsePersisted(raw: string | null): PersistedRemoteHostLocalOverrides | null {
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    const result = PersistedRemoteHostLocalOverridesSchema.safeParse(parsed);
    return result.success ? result.data : null;
}

function serializePersisted(value: PersistedRemoteHostLocalOverrides): string {
    return JSON.stringify(value);
}

export function createRemoteHostLocalOverridesStore(params: Readonly<{
    storage: KeyValueStringStorage;
    persistKey?: string;
}>): RemoteHostLocalOverridesStore {
    const persistKey = params.persistKey ?? REMOTE_HOST_LOCAL_OVERRIDES_PERSIST_KEY;

    function readPersisted(): PersistedRemoteHostLocalOverrides {
        return parsePersisted(params.storage.getString(persistKey)) ?? { version: 1, overridesById: {} };
    }

    function writePersisted(next: PersistedRemoteHostLocalOverrides): void {
        if (Object.keys(next.overridesById).length === 0) {
            params.storage.delete(persistKey);
        } else {
            params.storage.set(persistKey, serializePersisted(next));
        }
    }

    return {
        readAll: () => readPersisted().overridesById,
        get: (remoteHostId) => {
            const current = readPersisted();
            return current.overridesById[remoteHostId] ?? null;
        },
        set: (remoteHostId, overrides) => {
            const current = readPersisted();
            const next: PersistedRemoteHostLocalOverrides = {
                version: 1,
                overridesById: {
                    ...current.overridesById,
                    [remoteHostId]: overrides,
                },
            };
            writePersisted(next);
        },
        patch: (remoteHostId, delta) => {
            const current = readPersisted();
            const previous = current.overridesById[remoteHostId] ?? {};
            const nextOverrides = { ...previous, ...delta };
            const next: PersistedRemoteHostLocalOverrides = {
                version: 1,
                overridesById: {
                    ...current.overridesById,
                    [remoteHostId]: nextOverrides,
                },
            };
            writePersisted(next);
        },
        delete: (remoteHostId) => {
            const current = readPersisted();
            if (!Object.hasOwn(current.overridesById, remoteHostId)) return;
            const { [remoteHostId]: _, ...rest } = current.overridesById;
            writePersisted({ version: 1, overridesById: rest });
        },
    };
}

function createDefaultStorage(): KeyValueStringStorage {
    if (isWebRuntime) {
        return {
            getString: (key) => {
                try {
                    return typeof window?.localStorage?.getItem === 'function' ? window.localStorage.getItem(key) : null;
                } catch {
                    return null;
                }
            },
            set: (key, value) => {
                try {
                    if (typeof window?.localStorage?.setItem === 'function') window.localStorage.setItem(key, value);
                } catch {
                    // ignore
                }
            },
            delete: (key) => {
                try {
                    if (typeof window?.localStorage?.removeItem === 'function') window.localStorage.removeItem(key);
                } catch {
                    // ignore
                }
            },
        };
    }

    type MmkvStorage = import('react-native-mmkv').MMKV;
    const mmkvModule = require('react-native-mmkv') as typeof import('react-native-mmkv');
    const scope = readStorageScopeFromEnv();
    const storage: MmkvStorage = new mmkvModule.MMKV({ id: scopedStorageId('remote-host-local-overrides', scope) });
    return {
        getString: (key) => storage.getString(key) ?? null,
        set: (key, value) => {
            storage.set(key, value);
        },
        delete: (key) => {
            storage.delete(key);
        },
    };
}

let defaultStore: RemoteHostLocalOverridesStore | null = null;

export function getRemoteHostLocalOverridesStore(): RemoteHostLocalOverridesStore {
    defaultStore ??= createRemoteHostLocalOverridesStore({
        storage: createDefaultStorage(),
        persistKey: scopedStorageId(REMOTE_HOST_LOCAL_OVERRIDES_PERSIST_KEY, readStorageScopeFromEnv()),
    });
    return defaultStore;
}

export function readAllRemoteHostLocalOverrides(): RemoteHostLocalOverridesById {
    return getRemoteHostLocalOverridesStore().readAll();
}

export function getRemoteHostLocalOverrides(remoteHostId: RemoteHostId): RemoteHostLocalOverrides | null {
    return getRemoteHostLocalOverridesStore().get(remoteHostId);
}

export function setRemoteHostLocalOverrides(remoteHostId: RemoteHostId, overrides: RemoteHostLocalOverrides): void {
    getRemoteHostLocalOverridesStore().set(remoteHostId, overrides);
}

export function patchRemoteHostLocalOverrides(remoteHostId: RemoteHostId, delta: Partial<RemoteHostLocalOverrides>): void {
    getRemoteHostLocalOverridesStore().patch(remoteHostId, delta);
}

export function deleteRemoteHostLocalOverrides(remoteHostId: RemoteHostId): void {
    getRemoteHostLocalOverridesStore().delete(remoteHostId);
}

export function upsertRemoteHostLocalOverrides(remoteHostId: RemoteHostId, overrides: RemoteHostLocalOverrides | null): void {
    const identityFilePath = typeof overrides?.identityFilePath === 'string' ? overrides.identityFilePath.trim() : '';
    const sshConfigFilePath = typeof overrides?.sshConfigFilePath === 'string' ? overrides.sshConfigFilePath.trim() : '';
    const next: RemoteHostLocalOverrides = {
        ...(identityFilePath ? { identityFilePath } : {}),
        ...(sshConfigFilePath ? { sshConfigFilePath } : {}),
    };

    if (!next.identityFilePath && !next.sshConfigFilePath) {
        deleteRemoteHostLocalOverrides(remoteHostId);
        return;
    }

    setRemoteHostLocalOverrides(remoteHostId, next);
}
