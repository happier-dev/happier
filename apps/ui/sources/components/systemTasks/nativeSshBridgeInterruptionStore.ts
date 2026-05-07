import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';

import type {
    NativeSshBridgeInterruptionMarker,
    NativeSshBridgeInterruptionStore,
} from './createNativeSshBridge';

export type NativeSshBridgePersistenceStorage = Readonly<{
    getString: (key: string) => string | undefined;
    set: (key: string, value: string) => void;
    delete: (key: string) => void;
    getAllKeys?: () => string[];
}>;

const NATIVE_SSH_INTERRUPTION_KEY_PREFIX = 'native-ssh-interrupted:';

function parseInterruptionMarker(
    key: string,
    raw: string | undefined,
): NativeSshBridgeInterruptionMarker | null {
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw) as Partial<NativeSshBridgeInterruptionMarker>;
        if (
            parsed.key === key
            && typeof parsed.taskId === 'string'
            && typeof parsed.startedAtMs === 'number'
        ) {
            return {
                taskId: parsed.taskId,
                key: parsed.key,
                startedAtMs: parsed.startedAtMs,
            };
        }
    } catch {}
    return null;
}

export function createNativeSshBridgeInterruptionStore(
    storage: NativeSshBridgePersistenceStorage,
): NativeSshBridgeInterruptionStore {
    return {
        read: (key) => parseInterruptionMarker(key, storage.getString(key)),
        write: (marker) => {
            storage.set(marker.key, JSON.stringify(marker));
        },
        remove: (key) => {
            storage.delete(key);
        },
        list: () => (storage.getAllKeys?.() ?? [])
            .filter((key) => key.startsWith(NATIVE_SSH_INTERRUPTION_KEY_PREFIX))
            .flatMap((key) => {
                const marker = parseInterruptionMarker(key, storage.getString(key));
                return marker ? [marker] : [];
            }),
    };
}

export function createDefaultNativeSshBridgeInterruptionStore(): NativeSshBridgeInterruptionStore {
    return {
        read: (key) => {
            try {
                return parseInterruptionMarker(key, getPersistenceStorage().getString(key));
            } catch {
                return null;
            }
        },
        write: (marker) => {
            try {
                getPersistenceStorage().set(marker.key, JSON.stringify(marker));
            } catch {}
        },
        remove: (key) => {
            try {
                getPersistenceStorage().delete(key);
            } catch {}
        },
        list: () => {
            try {
                const storage = getPersistenceStorage();
                return storage.getAllKeys()
                    .filter((key) => key.startsWith(NATIVE_SSH_INTERRUPTION_KEY_PREFIX))
                    .flatMap((key) => {
                        const marker = parseInterruptionMarker(key, storage.getString(key));
                        return marker ? [marker] : [];
                    });
            } catch {
                return [];
            }
        },
    };
}
