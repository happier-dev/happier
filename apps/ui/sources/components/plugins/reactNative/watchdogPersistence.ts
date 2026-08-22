import { Platform } from 'react-native';
import { MMKV } from 'react-native-mmkv';

import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

import type {
    PluginReactNativeWatchdogPersistence,
    PluginReactNativeWatchdogSnapshot,
    PluginReactNativeWatchdogSnapshotRead,
} from './watchdog';

type WatchdogStringStorage = Readonly<{
    getString?: (key: string) => string | undefined;
    getItem?: (key: string) => string | null;
    set?: (key: string, value: string) => void;
    setItem?: (key: string, value: string) => void;
}>;

const NATIVE_STORAGE_BASE_ID = 'plugin-react-native-watchdog';
const SNAPSHOT_KEY = 'pending-v3';
const WEB_SNAPSHOT_BASE_KEY = 'happier:plugin-react-native-watchdog:pending-v3';

type WatchdogStoredValue =
    | Readonly<{ durability: 'available'; value: string }>
    | Readonly<{ durability: 'absent' }>
    | Readonly<{ durability: 'unavailable' }>;

const STORAGE_ABSENT: WatchdogStoredValue = Object.freeze({ durability: 'absent' });
const STORAGE_UNAVAILABLE: WatchdogStoredValue = Object.freeze({ durability: 'unavailable' });

/**
 * A key this store answered for and does not hold is `absent`; a store that
 * cannot be asked at all is `unavailable`. The watchdog needs that difference
 * to tell "nothing was quarantined" from "the quarantine cannot be read".
 */
function readStorageValue(storage: WatchdogStringStorage, key: string): WatchdogStoredValue {
    if (!storage.getString && !storage.getItem) {
        return STORAGE_UNAVAILABLE;
    }
    try {
        const value = storage.getString?.(key) ?? storage.getItem?.(key) ?? null;
        if (typeof value === 'string') {
            return Object.freeze({ durability: 'available' as const, value });
        }
        return value === null || value === undefined ? STORAGE_ABSENT : STORAGE_UNAVAILABLE;
    } catch {
        return STORAGE_UNAVAILABLE;
    }
}

function writeStorageValue(
    storage: WatchdogStringStorage,
    key: string,
    value: string,
): 'available' | 'unavailable' {
    try {
        if (storage.set) {
            storage.set(key, value);
            return 'available';
        }
        if (storage.setItem) {
            storage.setItem(key, value);
            return 'available';
        }
        return 'unavailable';
    } catch {
        // The write is still best-effort for the running mount, which stays
        // quarantined in memory, but the watchdog must know this snapshot never
        // became durable truth.
        return 'unavailable';
    }
}

function resolveWebStorage(): WatchdogStringStorage | null {
    const windowStorage = globalThis.window?.localStorage;
    if (windowStorage && typeof windowStorage.getItem === 'function' && typeof windowStorage.setItem === 'function') {
        return windowStorage;
    }
    const localStorage = globalThis.localStorage;
    if (localStorage && typeof localStorage.getItem === 'function' && typeof localStorage.setItem === 'function') {
        return localStorage;
    }
    return null;
}

export function createPluginReactNativeWatchdogStoragePersistence(params: Readonly<{
    storage: WatchdogStringStorage;
    key: string;
}>): PluginReactNativeWatchdogPersistence {
    return Object.freeze({
        readSnapshot: (): PluginReactNativeWatchdogSnapshotRead => {
            const raw = readStorageValue(params.storage, params.key);
            if (raw.durability !== 'available') {
                return Object.freeze({ durability: raw.durability });
            }
            try {
                return Object.freeze({
                    durability: 'available' as const,
                    snapshot: JSON.parse(raw.value) as unknown,
                });
            } catch {
                // Stored bytes exist but cannot be interpreted. That is a
                // quarantine this UI cannot account for, not an absent one.
                return Object.freeze({ durability: 'unavailable' as const });
            }
        },
        writeSnapshot: (snapshot: PluginReactNativeWatchdogSnapshot) => writeStorageValue(
            params.storage,
            params.key,
            JSON.stringify(snapshot),
        ),
    });
}

export function createDefaultPluginReactNativeWatchdogPersistence(): PluginReactNativeWatchdogPersistence | undefined {
    const scope = readStorageScopeFromEnv();
    if (Platform.OS === 'web') {
        const storage = resolveWebStorage();
        if (!storage) {
            return undefined;
        }
        return createPluginReactNativeWatchdogStoragePersistence({
            storage,
            key: scopedStorageId(WEB_SNAPSHOT_BASE_KEY, scope),
        });
    }

    try {
        return createPluginReactNativeWatchdogStoragePersistence({
            storage: new MMKV({ id: scopedStorageId(NATIVE_STORAGE_BASE_ID, scope) }),
            key: SNAPSHOT_KEY,
        });
    } catch {
        return undefined;
    }
}
