import { z } from 'zod';

import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

import type {
    RemoteHostTrustedHostKeyLookup,
    RemoteHostTrustedHostKeyRecord,
    RemoteHostTrustedHostKeyStore,
    RemoteHostTrustedHostKeyTrustParams,
} from './model';
import {
    normalizeRemoteHostTrustedHostKeyFingerprint,
    normalizeRemoteHostTrustedHostKeyLookup,
} from './normalizeTrustedHostKey';

type KeyValueStringStorage = Readonly<{
    getString: (key: string) => string | null;
    set: (key: string, value: string) => void;
    delete: (key: string) => void;
}>;

const TrustedHostKeyRecordSchema = z.object({
    hostLower: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    algorithm: z.string().min(1),
    fingerprintSha256: z.string().min(1),
    trustedAtMs: z.number().int().min(0),
    lastSeenAtMs: z.number().int().min(0),
    remoteHostId: z.string().min(1).optional(),
    source: z.literal('remote-host'),
}).strict();

const PersistedTrustedHostKeysSchema = z.object({
    version: z.literal(1),
    recordsByKey: z.record(z.string(), TrustedHostKeyRecordSchema),
}).strict();

type PersistedTrustedHostKeys = z.infer<typeof PersistedTrustedHostKeysSchema>;

export const REMOTE_HOST_TRUSTED_HOST_KEYS_PERSIST_KEY = 'remote-host-trusted-host-keys-v1';

const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';

function parsePersisted(raw: string | null): PersistedTrustedHostKeys | null {
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    const result = PersistedTrustedHostKeysSchema.safeParse(parsed);
    return result.success ? result.data : null;
}

function emptyPersisted(): PersistedTrustedHostKeys {
    return { version: 1, recordsByKey: {} };
}

export function createRemoteHostTrustedHostKeyStore(params: Readonly<{
    storage: KeyValueStringStorage;
    persistKey?: string;
}>): RemoteHostTrustedHostKeyStore {
    const persistKey = params.persistKey ?? REMOTE_HOST_TRUSTED_HOST_KEYS_PERSIST_KEY;

    function readPersisted(): PersistedTrustedHostKeys {
        return parsePersisted(params.storage.getString(persistKey)) ?? emptyPersisted();
    }

    function writePersisted(next: PersistedTrustedHostKeys): void {
        if (Object.keys(next.recordsByKey).length === 0) {
            params.storage.delete(persistKey);
            return;
        }
        params.storage.set(persistKey, JSON.stringify(next));
    }

    return {
        readAll: () => Object.values(readPersisted().recordsByKey),
        get: (lookup) => {
            const normalized = normalizeRemoteHostTrustedHostKeyLookup(lookup);
            return readPersisted().recordsByKey[normalized.key] ?? null;
        },
        trust: (trustParams: RemoteHostTrustedHostKeyTrustParams) => {
            const normalized = normalizeRemoteHostTrustedHostKeyLookup(trustParams);
            const current = readPersisted();
            const nowMs = trustParams.nowMs ?? Date.now();
            const previous = current.recordsByKey[normalized.key] ?? null;
            const record: RemoteHostTrustedHostKeyRecord = {
                hostLower: normalized.hostLower,
                port: normalized.port,
                algorithm: normalized.algorithm,
                fingerprintSha256: normalizeRemoteHostTrustedHostKeyFingerprint(trustParams.fingerprintSha256),
                trustedAtMs: previous?.trustedAtMs ?? nowMs,
                lastSeenAtMs: nowMs,
                ...(trustParams.remoteHostId?.trim() ? { remoteHostId: trustParams.remoteHostId.trim() } : {}),
                source: 'remote-host',
            };
            writePersisted({
                version: 1,
                recordsByKey: {
                    ...current.recordsByKey,
                    [normalized.key]: record,
                },
            });
            return record;
        },
        markSeen: (lookup) => {
            const normalized = normalizeRemoteHostTrustedHostKeyLookup(lookup);
            const current = readPersisted();
            const previous = current.recordsByKey[normalized.key];
            if (!previous) return;
            writePersisted({
                version: 1,
                recordsByKey: {
                    ...current.recordsByKey,
                    [normalized.key]: {
                        ...previous,
                        lastSeenAtMs: lookup.nowMs ?? Date.now(),
                    },
                },
            });
        },
        delete: (lookup: RemoteHostTrustedHostKeyLookup) => {
            const normalized = normalizeRemoteHostTrustedHostKeyLookup(lookup);
            const current = readPersisted();
            if (!Object.hasOwn(current.recordsByKey, normalized.key)) return;
            const { [normalized.key]: _, ...rest } = current.recordsByKey;
            writePersisted({ version: 1, recordsByKey: rest });
        },
        clear: () => {
            writePersisted(emptyPersisted());
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
                    // ignore local persistence failures
                }
            },
            delete: (key) => {
                try {
                    if (typeof window?.localStorage?.removeItem === 'function') window.localStorage.removeItem(key);
                } catch {
                    // ignore local persistence failures
                }
            },
        };
    }

    type MmkvStorage = import('react-native-mmkv').MMKV;
    const mmkvModule = require('react-native-mmkv') as typeof import('react-native-mmkv');
    const scope = readStorageScopeFromEnv();
    const storage: MmkvStorage = new mmkvModule.MMKV({ id: scopedStorageId('remote-host-trusted-host-keys', scope) });
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

let defaultStore: RemoteHostTrustedHostKeyStore | null = null;

export function getRemoteHostTrustedHostKeyStore(): RemoteHostTrustedHostKeyStore {
    defaultStore ??= createRemoteHostTrustedHostKeyStore({
        storage: createDefaultStorage(),
        persistKey: scopedStorageId(REMOTE_HOST_TRUSTED_HOST_KEYS_PERSIST_KEY, readStorageScopeFromEnv()),
    });
    return defaultStore;
}
