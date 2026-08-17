import { Platform } from 'react-native';

import {
    readNativeSecureStoreString,
    removeNativeSecureStoreString,
    writeNativeSecureStoreString,
} from './nativeSecureStoreWithDevFallback';

function resolveWebStorageBackend(): Storage | null {
    const windowStorage = (globalThis as { window?: { localStorage?: Storage } }).window?.localStorage;
    if (windowStorage && typeof windowStorage.getItem === 'function') return windowStorage;

    const localStorage = (globalThis as { localStorage?: Storage }).localStorage;
    if (localStorage && typeof localStorage.getItem === 'function') return localStorage;

    return null;
}

function requireWebStorageBackend(): Storage {
    const storage = resolveWebStorageBackend();
    if (!storage) {
        throw new Error('Browser-origin device-local storage is unavailable');
    }
    return storage;
}

/**
 * Device-local custody used for authentication material and local-only secret keys.
 *
 * Native runtimes use the OS secure store. Web runtimes use the same origin-scoped
 * storage boundary as the bearer token; this prevents raw secret values from being
 * persisted but is not an E2EE or hardware-backed security claim.
 */
export async function readDeviceLocalStorageString(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
        return resolveWebStorageBackend()?.getItem(key) ?? null;
    }
    return await readNativeSecureStoreString(key);
}

export async function writeDeviceLocalStorageString(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
        requireWebStorageBackend().setItem(key, value);
        return;
    }
    await writeNativeSecureStoreString(key, value);
}

export async function removeDeviceLocalStorageString(key: string): Promise<void> {
    if (Platform.OS === 'web') {
        requireWebStorageBackend().removeItem(key);
        return;
    }
    await removeNativeSecureStoreString(key);
}
