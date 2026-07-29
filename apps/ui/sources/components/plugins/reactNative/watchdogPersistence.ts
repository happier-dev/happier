import { Platform } from 'react-native';
import { MMKV } from 'react-native-mmkv';

import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

import type {
    PluginReactNativeWatchdogPersistence,
    PluginReactNativeWatchdogSnapshot,
} from './watchdog';

type WatchdogStringStorage = Readonly<{
    getString?: (key: string) => string | undefined;
    getItem?: (key: string) => string | null;
    set?: (key: string, value: string) => void;
    setItem?: (key: string, value: string) => void;
}>;

const NATIVE_STORAGE_BASE_ID = 'plugin-react-native-watchdog';
const SNAPSHOT_KEY = 'state-v1';
const WEB_SNAPSHOT_BASE_KEY = 'happier:plugin-react-native-watchdog:state-v1';

function readStorageValue(storage: WatchdogStringStorage, key: string): string | null {
    try {
        const value = storage.getString?.(key) ?? storage.getItem?.(key) ?? null;
        return typeof value === 'string' ? value : null;
    } catch {
        return null;
    }
}

function writeStorageValue(storage: WatchdogStringStorage, key: string, value: string): void {
    try {
        if (storage.set) {
            storage.set(key, value);
            return;
        }
        storage.setItem?.(key, value);
    } catch {
        // Persistence is best-effort; the watchdog must still contain crashes in memory.
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
        readSnapshot: () => {
            const raw = readStorageValue(params.storage, params.key);
            if (!raw) {
                return null;
            }
            try {
                return JSON.parse(raw) as unknown;
            } catch {
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
