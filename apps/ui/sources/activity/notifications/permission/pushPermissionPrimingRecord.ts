import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

/**
 * Device-local record of whether we already asked, in-app, for permission to enable push.
 *
 * This is deliberately local rather than an account setting: the OS permission it guards is
 * per-install, so the record must not follow the account onto another device that has never been
 * asked. It exists so a declined in-app explainer is not re-shown on every launch.
 */
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
    storage = new mmkvModule.MMKV({ id: scopedStorageId('push-permission-priming', scope) });
    return storage;
}

const KEY_DECLINED_IN_APP_PROMPT = 'declinedInAppPromptV1';
const LOCAL_STORAGE_KEY_DECLINED_IN_APP_PROMPT =
    `${scopedStorageId('push-permission-priming', null)}:${KEY_DECLINED_IN_APP_PROMPT}`;

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

export function hasDeclinedPushPermissionPriming(): boolean {
    try {
        if (isWebRuntime) {
            return safeLocalStorageGetString(LOCAL_STORAGE_KEY_DECLINED_IN_APP_PROMPT) === 'true';
        }
        return getStorage().getBoolean(KEY_DECLINED_IN_APP_PROMPT) === true;
    } catch {
        return false;
    }
}

export function recordDeclinedPushPermissionPriming(): void {
    try {
        if (isWebRuntime) {
            safeLocalStorageSetString(LOCAL_STORAGE_KEY_DECLINED_IN_APP_PROMPT, 'true');
            return;
        }
        getStorage().set(KEY_DECLINED_IN_APP_PROMPT, true);
    } catch {
        // A missing local record only costs one extra explainer; never fail the flow for it.
    }
}

/**
 * Clears the decline record so an explicit user action (enabling push in settings, or running
 * troubleshooting) can ask again without being suppressed by an earlier decline.
 */
export function clearDeclinedPushPermissionPriming(): void {
    try {
        if (isWebRuntime) {
            safeLocalStorageDelete(LOCAL_STORAGE_KEY_DECLINED_IN_APP_PROMPT);
            return;
        }
        getStorage().delete(KEY_DECLINED_IN_APP_PROMPT);
    } catch {
        // ignore
    }
}
