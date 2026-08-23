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

/** The stored string, or `null` when this store holds none or cannot answer. */
function readStorageValue(storage: WatchdogStringStorage, key: string): string | null {
    try {
        const value = storage.getString?.(key) ?? storage.getItem?.(key) ?? null;
        return typeof value === 'string' ? value : null;
    } catch {
        return null;
    }
}

function writeStorageValue(storage: WatchdogStringStorage, key: string, value: string): void {
    // Best effort: this outbox exists so an unreported occurrence survives a
    // restart. A store that refuses the write costs that report, never the
    // running mount.
    try {
        if (storage.set) {
            storage.set(key, value);
        } else {
            storage.setItem?.(key, value);
        }
    } catch {
        // Intentionally ignored; the daemon owns durable crash state.
    }
}

function resolveWebStorage(): WatchdogStringStorage | null {
    // Browsers that block site data throw from the `localStorage` getter
    // itself, so even reading the property is a failure mode. This mirrors the
    // native branch: no reachable store degrades to "no durable persistence",
    // never to an exception that would take the whole surface module down.
    try {
        const windowStorage = globalThis.window?.localStorage;
        if (windowStorage && typeof windowStorage.getItem === 'function' && typeof windowStorage.setItem === 'function') {
            return windowStorage;
        }
        const localStorage = globalThis.localStorage;
        if (localStorage && typeof localStorage.getItem === 'function' && typeof localStorage.setItem === 'function') {
            return localStorage;
        }
    } catch {
        return null;
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
            if (raw === null) {
                return null;
            }
            try {
                return Object.freeze({ snapshot: JSON.parse(raw) as unknown });
            } catch {
                // Bytes this version cannot interpret carry no reportable
                // occurrence, so there is nothing to restore.
                return null;
            }
        },
        writeSnapshot: (snapshot: PluginReactNativeWatchdogSnapshot) => {
            writeStorageValue(params.storage, params.key, JSON.stringify(snapshot));
        },
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
