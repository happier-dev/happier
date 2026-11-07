import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

/**
 * Fingerprint unlock (Android). A copy of the app-lock data key is kept in the Android Keystore
 * behind biometric authentication, so reading it shows the system fingerprint prompt. Android
 * invalidates the entry when fingerprints change; the password then still works.
 */

const BIOMETRIC_KEY_BASE = 'app_lock_biometric_key_v1';

function biometricStorageKey(): string {
    return scopedStorageId(BIOMETRIC_KEY_BASE, readStorageScopeFromEnv());
}

export function canUseAppLockBiometrics(): boolean {
    if (Platform.OS !== 'android') return false;
    try {
        return SecureStore.canUseBiometricAuthentication();
    } catch {
        return false;
    }
}

/** Stores the data key behind a fingerprint check. Returns false if the user cancelled or it failed. */
export async function storeAppLockBiometricKey(dataKey: Uint8Array, prompt: string): Promise<boolean> {
    try {
        await SecureStore.setItemAsync(biometricStorageKey(), encodeBase64(dataKey), {
            requireAuthentication: true,
            authenticationPrompt: prompt,
        });
        return true;
    } catch (error) {
        console.error('[appLock] Could not set up fingerprint unlock:', error instanceof Error ? error.message : String(error));
        return false;
    }
}

/** Shows the fingerprint prompt and returns the data key, or null if cancelled or unavailable. */
export async function readAppLockBiometricKey(prompt: string): Promise<Uint8Array | null> {
    try {
        const stored = await SecureStore.getItemAsync(biometricStorageKey(), {
            requireAuthentication: true,
            authenticationPrompt: prompt,
        });
        if (!stored) return null;
        const key = decodeBase64(stored);
        return key.length === 32 ? key : null;
    } catch (error) {
        console.error('[appLock] Fingerprint unlock failed:', error instanceof Error ? error.message : String(error));
        return null;
    }
}

export async function removeAppLockBiometricKey(): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
        await SecureStore.deleteItemAsync(biometricStorageKey());
    } catch (error) {
        console.error('[appLock] Could not remove fingerprint unlock key:', error instanceof Error ? error.message : String(error));
    }
}
