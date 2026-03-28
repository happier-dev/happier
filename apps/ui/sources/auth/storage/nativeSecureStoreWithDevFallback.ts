import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { parseOptionalBooleanEnv } from '@happier-dev/protocol';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

const EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK = 'EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK';
const DEV_FALLBACK_STORAGE_ID = 'auth-secure-store-dev-fallback';

type FallbackStorage = Readonly<{
    getString: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
}>;

function shouldAllowDevFallback(): boolean {
    if (Platform.OS === 'web') return false;
    const parsed = parseOptionalBooleanEnv(process.env[EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK]);
    if (parsed !== null) return parsed;
    return typeof __DEV__ !== 'undefined' ? __DEV__ : false;
}

function isSecureStoreEntitlementMissingError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const normalized = message.trim().toLowerCase();
    return (
        normalized.includes("required entitlement isn't present")
        || normalized.includes('required entitlement isn’t present')
    );
}

function shouldUseDevFallback(error: unknown): boolean {
    return shouldAllowDevFallback() && isSecureStoreEntitlementMissingError(error);
}

async function getFallbackStorage(): Promise<FallbackStorage> {
    if (Platform.OS === 'web') {
        throw new Error('Native secure-store fallback is not available on web runtime');
    }
    const scope = readStorageScopeFromEnv();
    return {
        getString: async (key: string) => await AsyncStorage.getItem(scopedStorageId(`${DEV_FALLBACK_STORAGE_ID}:${key}`, scope)),
        set: async (key: string, value: string) => {
            await AsyncStorage.setItem(scopedStorageId(`${DEV_FALLBACK_STORAGE_ID}:${key}`, scope), value);
        },
        delete: async (key: string) => {
            await AsyncStorage.removeItem(scopedStorageId(`${DEV_FALLBACK_STORAGE_ID}:${key}`, scope));
        },
    };
}

async function readFallbackString(key: string): Promise<string | null> {
    const storage = await getFallbackStorage();
    return (await storage.getString(key)) ?? null;
}

async function writeFallbackString(key: string, value: string): Promise<void> {
    await (await getFallbackStorage()).set(key, value);
}

async function removeFallbackString(key: string): Promise<void> {
    await (await getFallbackStorage()).delete(key);
}

export async function readNativeSecureStoreString(key: string): Promise<string | null> {
    try {
        const stored = await SecureStore.getItemAsync(key);
        if (stored != null) return stored;
        if (!shouldAllowDevFallback()) return null;
        return await readFallbackString(key);
    } catch (error) {
        if (!shouldUseDevFallback(error)) throw error;
        return await readFallbackString(key);
    }
}

export async function writeNativeSecureStoreString(key: string, value: string): Promise<void> {
    try {
        await SecureStore.setItemAsync(key, value);
        if (shouldAllowDevFallback()) {
            await removeFallbackString(key);
        }
    } catch (error) {
        if (!shouldUseDevFallback(error)) throw error;
        await writeFallbackString(key, value);
    }
}

export async function removeNativeSecureStoreString(key: string): Promise<void> {
    let storedError: unknown = null;
    try {
        await SecureStore.deleteItemAsync(key);
    } catch (error) {
        if (!shouldUseDevFallback(error)) {
            storedError = error;
        }
    }

    if (shouldAllowDevFallback()) {
        await removeFallbackString(key);
    }

    if (storedError) {
        throw storedError;
    }
}
