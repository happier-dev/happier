import * as SecureStore from 'expo-secure-store';

import { getRandomBytesAsync } from '@/platform/cryptoRandom';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

/**
 * Owns the at-rest key for the session warm cache.
 *
 * The warm cache holds session names, summaries, paths and hostnames *after* decryption, so on a
 * native build the file backing it is the one place where otherwise end-to-end-encrypted session
 * content would sit as plaintext on disk — credentials there live in the OS keystore, which the
 * cache file is not. The key lives in that same keystore (Keychain / Android Keystore) and is
 * generated once from the platform CSPRNG; nothing about it is derived from a device id, account
 * id or any other guessable input, because a derivable key would make the encryption decorative.
 *
 * Web is not that shape and does not use this module: see `resolveWarmCacheStoragePlacement` in
 * `warmCachePersistence.ts` for why the cache is deliberately plaintext there.
 *
 * Resolution is async and the warm-cache accessor is synchronous and on the boot critical path, so
 * boot resolves this once, in parallel with the credential read it already performs, and the
 * accessor only ever reads the settled answer.
 *
 * Every failure mode resolves to `unavailable` rather than throwing: the warm cache is derived
 * state, so "no key" must degrade to a cold boot and never wedge startup.
 *
 * This deliberately talks to `expo-secure-store` directly instead of reusing
 * `@/auth/storage/nativeSecureStoreWithDevFallback`. That wrapper mirrors auth secrets into
 * AsyncStorage when a development build lacks the keychain entitlement, which is the right trade
 * for credentials (without them a dev build cannot sign in at all) and the wrong one here: a key
 * sitting in AsyncStorage would leave the cache file encrypted with a secret stored in the clear
 * beside it. A cache that simply does not persist is the strictly safer degradation.
 */

/**
 * MMKV builds its AES key from the first `AES_KEY_LEN` (16) bytes of this string and silently
 * discards the rest (`react-native-mmkv/MMKV/Core/aes/AESCrypt.cpp`), so a longer key is not a
 * stronger key — it is the same key with a false sense of size. The alphabet below is 64 ASCII
 * characters and 256 % 64 === 0, so mapping one random byte per character is uniform: 16
 * characters carry 96 bits of entropy in exactly 16 bytes.
 */
const WARM_CACHE_ENCRYPTION_KEY_LENGTH = 16;
const WARM_CACHE_ENCRYPTION_KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const WARM_CACHE_ENCRYPTION_KEY_STORE_KEY = 'warm-cache-encryption-key-v1';

/**
 * The same predicate the rest of this corridor uses (`state/persistence.ts`,
 * `warmCachePersistence.ts`, `utils/system/sentry.ts`): React Native defines `window` but never
 * `document`, so a DOM document is what actually separates the browser and Tauri desktop bundles
 * from a native build. Neither has a keystore to hold the key, and MMKV's web backend throws on
 * `encryptionKey` outright, so there is no key to resolve there.
 */
function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

export type WarmCacheEncryptionKeyResolution =
    | Readonly<{ kind: 'ready'; key: string }>
    /**
     * `unsupported-platform`: the runtime has no keystore and no store that would accept the key
     * (web, and the Tauri desktop shell that ships the same bundle). The warm cache still persists
     * there, in plaintext and on purpose — `resolveWarmCacheStoragePlacement` owns that decision.
     * `keystore-unavailable`: the keystore exists but could not be read or written this boot.
     */
    | Readonly<{ kind: 'unavailable'; reason: 'unsupported-platform' | 'keystore-unavailable' }>;

let resolvedWarmCacheEncryptionKey: WarmCacheEncryptionKeyResolution | null = null;
let warmCacheEncryptionKeyInFlight: Promise<WarmCacheEncryptionKeyResolution> | null = null;

function warmCacheEncryptionKeyStoreKey(): string {
    return scopedStorageId(WARM_CACHE_ENCRYPTION_KEY_STORE_KEY, readStorageScopeFromEnv());
}

function isWarmCacheEncryptionKeyShaped(value: string | null): value is string {
    if (value === null || value.length !== WARM_CACHE_ENCRYPTION_KEY_LENGTH) return false;
    for (const character of value) {
        if (!WARM_CACHE_ENCRYPTION_KEY_ALPHABET.includes(character)) return false;
    }
    return true;
}

function encodeWarmCacheEncryptionKey(bytes: Uint8Array): string {
    let key = '';
    for (let index = 0; index < WARM_CACHE_ENCRYPTION_KEY_LENGTH; index += 1) {
        // Uniform 6-bit slice of one CSPRNG byte (the alphabet is exactly 64 characters).
        key += WARM_CACHE_ENCRYPTION_KEY_ALPHABET[(bytes[index] ?? 0) & 63];
    }
    return key;
}

async function resolveWarmCacheEncryptionKeyOnce(): Promise<WarmCacheEncryptionKeyResolution> {
    if (isWebRuntime()) return { kind: 'unavailable', reason: 'unsupported-platform' };
    try {
        const storeKey = warmCacheEncryptionKeyStoreKey();
        const existing = await SecureStore.getItemAsync(storeKey);
        if (isWarmCacheEncryptionKeyShaped(existing)) return { kind: 'ready', key: existing };

        const generated = encodeWarmCacheEncryptionKey(
            await getRandomBytesAsync(WARM_CACHE_ENCRYPTION_KEY_LENGTH),
        );
        // A key we cannot persist is worse than no key: it would encrypt this run's cache with a
        // secret the next run can never reproduce, leaving an undecryptable file behind. Treat a
        // failed write as "no key" and fall back to not persisting at all.
        await SecureStore.setItemAsync(storeKey, generated);
        return { kind: 'ready', key: generated };
    } catch {
        return { kind: 'unavailable', reason: 'keystore-unavailable' };
    }
}

/**
 * Resolves the key once per process. Safe to call concurrently and repeatedly; never rejects.
 */
export function prepareWarmCacheEncryptionKey(): Promise<WarmCacheEncryptionKeyResolution> {
    const settled = resolvedWarmCacheEncryptionKey;
    if (settled) return Promise.resolve(settled);
    warmCacheEncryptionKeyInFlight ??= resolveWarmCacheEncryptionKeyOnce().then((resolution) => {
        resolvedWarmCacheEncryptionKey = resolution;
        warmCacheEncryptionKeyInFlight = null;
        return resolution;
    });
    return warmCacheEncryptionKeyInFlight;
}

/**
 * The settled key, or `null` when it is unavailable *or not resolved yet*. Both answers mean the
 * same thing to a caller: do not persist decrypted content right now.
 */
export function readResolvedWarmCacheEncryptionKey(): string | null {
    return resolvedWarmCacheEncryptionKey?.kind === 'ready' ? resolvedWarmCacheEncryptionKey.key : null;
}
