import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';

type MmkvStorage = import('react-native-mmkv').MMKV;

let storage: MmkvStorage | null = null;

function getStorage(): MmkvStorage {
    if (storage) return storage;
    if (isWebRuntime) {
        throw new Error('MMKV storage is not available on web runtime');
    }
    const mmkvModule = require('react-native-mmkv') as typeof import('react-native-mmkv');
    const scope = readStorageScopeFromEnv();
    storage = new mmkvModule.MMKV({ id: scopedStorageId('push-token-registration', scope) });
    return storage;
}

const KEY_LAST_EXPO_PUSH_TOKEN = 'lastExpoPushTokenV1';
const LOCAL_STORAGE_KEY_LAST_EXPO_PUSH_TOKEN = `${scopedStorageId('push-token-registration', null)}:${KEY_LAST_EXPO_PUSH_TOKEN}`;

function safeLocalStorageGetString(key: string): string | null {
    try {
        return typeof window?.localStorage?.getItem === 'function' ? window.localStorage.getItem(key) : null;
    } catch {
        return null;
    }
}

function safeLocalStorageSetString(key: string, value: string): void {
    try {
        if (typeof window?.localStorage?.setItem === 'function') {
            window.localStorage.setItem(key, value);
        }
    } catch {
        // ignore
    }
}

function safeLocalStorageDelete(key: string): void {
    try {
        if (typeof window?.localStorage?.removeItem === 'function') {
            window.localStorage.removeItem(key);
        }
    } catch {
        // ignore
    }
}

export function loadLastRegisteredExpoPushToken(): string | null {
    if (isWebRuntime) {
        return safeLocalStorageGetString(LOCAL_STORAGE_KEY_LAST_EXPO_PUSH_TOKEN);
    }
    return getStorage().getString(KEY_LAST_EXPO_PUSH_TOKEN) ?? null;
}

export function saveLastRegisteredExpoPushToken(token: string): void {
    const value = String(token ?? '').trim();
    if (!value) return;
    if (isWebRuntime) {
        safeLocalStorageSetString(LOCAL_STORAGE_KEY_LAST_EXPO_PUSH_TOKEN, value);
        return;
    }
    getStorage().set(KEY_LAST_EXPO_PUSH_TOKEN, value);
}

export function clearLastRegisteredExpoPushToken(): void {
    if (isWebRuntime) {
        safeLocalStorageDelete(LOCAL_STORAGE_KEY_LAST_EXPO_PUSH_TOKEN);
        return;
    }
    getStorage().delete(KEY_LAST_EXPO_PUSH_TOKEN);
}
