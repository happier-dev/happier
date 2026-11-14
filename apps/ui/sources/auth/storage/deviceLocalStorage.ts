import { Platform } from 'react-native';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';

import { desktopHostKind, invokeDesktopHost } from '@/utils/platform/desktopHost';

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

const DESKTOP_SECURE_STORAGE_COMMANDS = {
    read: 'desktop_secure_storage_read',
    write: 'desktop_secure_storage_write',
    remove: 'desktop_secure_storage_remove',
} as const;

const deviceLocalStorageOperationTails = new Map<string, Promise<void>>();
const embedLocalValues = new Map<string, string>();

async function serializeDeviceLocalStorageOperation<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = deviceLocalStorageOperationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    deviceLocalStorageOperationTails.set(key, current);
    await previous;
    try {
        return await run();
    } finally {
        release();
        if (deviceLocalStorageOperationTails.get(key) === current) {
            deviceLocalStorageOperationTails.delete(key);
        }
    }
}

function isDesktopWebRuntime(): boolean {
    return Platform.OS === 'web' && desktopHostKind() !== null;
}

async function readDesktopSecureStorageString(key: string): Promise<string | null> {
    return await invokeDesktopHost<string | null>(DESKTOP_SECURE_STORAGE_COMMANDS.read, { key });
}

async function writeDesktopSecureStorageString(key: string, value: string): Promise<void> {
    await invokeDesktopHost<null>(DESKTOP_SECURE_STORAGE_COMMANDS.write, { key, value });
}

async function removeDesktopSecureStorageString(key: string): Promise<void> {
    await invokeDesktopHost<null>(DESKTOP_SECURE_STORAGE_COMMANDS.remove, { key });
}

async function discardUnverifiedDesktopStorageString(key: string): Promise<void> {
    try {
        await removeDesktopSecureStorageString(key);
    } catch {
        // Preserve the original custody failure. A later native-first read still fails closed.
    }
}

/**
 * Device-local custody used for authentication material and local-only secret keys.
 *
 * Native mobile and recognized Desktop runtimes use OS-protected storage. Browser web
 * retains the existing origin-scoped localStorage boundary; that is local custody, not
 * an encryption-at-rest, E2EE, or hardware-backed security claim.
 */
async function readDeviceLocalStorageStringUnserialized(key: string): Promise<string | null> {
    if (isEmbedWindowContext()) return embedLocalValues.get(key) ?? null;
    if (isDesktopWebRuntime()) {
        const nativeValue = await readDesktopSecureStorageString(key);
        if (nativeValue !== null) return nativeValue;

        const legacyStorage = resolveWebStorageBackend();
        const legacyValue = legacyStorage?.getItem(key) ?? null;
        if (legacyValue === null) return null;

        try {
            // A concurrent writer may have populated primary custody after the
            // initial miss. Re-read before migration so legacy bytes can never
            // overwrite a newer credential.
            const concurrentPrimary = await readDesktopSecureStorageString(key);
            if (concurrentPrimary !== null) {
                legacyStorage?.removeItem(key);
                return concurrentPrimary;
            }
            await writeDesktopSecureStorageString(key, legacyValue);
            const verifiedValue = await readDesktopSecureStorageString(key);
            if (verifiedValue === legacyValue) {
                legacyStorage?.removeItem(key);
                return legacyValue;
            }
            throw new Error('Desktop secure storage migration verification failed');
        } catch (error) {
            await discardUnverifiedDesktopStorageString(key);
            // Retain the exact legacy bytes for a later migration retry, but never authenticate
            // from plaintext storage after Desktop secure custody has failed.
            throw error;
        }
    }

    if (Platform.OS === 'web') {
        return resolveWebStorageBackend()?.getItem(key) ?? null;
    }
    return await readNativeSecureStoreString(key);
}

async function writeDeviceLocalStorageStringUnserialized(key: string, value: string): Promise<void> {
    if (isEmbedWindowContext()) { embedLocalValues.set(key, value); return; }
    if (isDesktopWebRuntime()) {
        try {
            await writeDesktopSecureStorageString(key, value);
            const verifiedValue = await readDesktopSecureStorageString(key);
            if (verifiedValue !== value) {
                throw new Error('Desktop secure storage write verification failed');
            }
        } catch (error) {
            await discardUnverifiedDesktopStorageString(key);
            throw error;
        }
        resolveWebStorageBackend()?.removeItem(key);
        return;
    }

    if (Platform.OS === 'web') {
        requireWebStorageBackend().setItem(key, value);
        return;
    }
    await writeNativeSecureStoreString(key, value);
}

async function removeDeviceLocalStorageStringUnserialized(key: string): Promise<void> {
    if (isEmbedWindowContext()) { embedLocalValues.delete(key); return; }
    if (isDesktopWebRuntime()) {
        let nativeFailure: unknown;
        try {
            await removeDesktopSecureStorageString(key);
        } catch (error) {
            nativeFailure = error;
        }
        resolveWebStorageBackend()?.removeItem(key);
        if (nativeFailure !== undefined) throw nativeFailure;
        return;
    }

    if (Platform.OS === 'web') {
        requireWebStorageBackend().removeItem(key);
        return;
    }
    await removeNativeSecureStoreString(key);
}

/**
 * A read of a key that is queued but has not started yet. It answers every later read of the same
 * key: its storage call happens after all of them were issued, and a write or remove queued after it
 * retires it, so a read never sees a value older than one this realm wrote before asking. Without it,
 * a burst of credential reads (one per request, more on a Home switch) became one serialized host
 * round trip each on desktop.
 */
const queuedDeviceLocalReads = new Map<string, Promise<string | null>>();

export async function readDeviceLocalStorageString(key: string): Promise<string | null> {
    const queued = queuedDeviceLocalReads.get(key);
    if (queued) return await queued;
    const read: Promise<string | null> = serializeDeviceLocalStorageOperation(key, async () => {
        if (queuedDeviceLocalReads.get(key) === read) queuedDeviceLocalReads.delete(key);
        return await readDeviceLocalStorageStringUnserialized(key);
    });
    queuedDeviceLocalReads.set(key, read);
    return await read;
}

export async function writeDeviceLocalStorageString(key: string, value: string): Promise<void> {
    queuedDeviceLocalReads.delete(key);
    await serializeDeviceLocalStorageOperation(key, async () => await writeDeviceLocalStorageStringUnserialized(key, value));
}

export async function removeDeviceLocalStorageString(key: string): Promise<void> {
    queuedDeviceLocalReads.delete(key);
    await serializeDeviceLocalStorageOperation(key, async () => await removeDeviceLocalStorageStringUnserialized(key));
}
