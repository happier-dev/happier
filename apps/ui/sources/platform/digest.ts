/**
 * Platform adapter: message digest.
 *
 * Strategy:
 * - App runtime (native + web): use `expo-crypto` (Expo provides a web implementation internally).
 * - Tests (vitest/node): alias `@/platform/digest` to `digest.node.ts`.
 */

import * as ExpoCrypto from 'expo-crypto';
import { Platform } from 'react-native';

export type DigestAlgorithm = 'SHA-256' | 'SHA-512';

function isWebRuntime(): boolean {
    return Platform.OS === 'web';
}

function hasWebCryptoSubtleDigest(): boolean {
    const cryptoObj = (globalThis as any).crypto as Crypto | undefined;
    return typeof cryptoObj?.subtle?.digest === 'function';
}

function createWebCryptoUnavailableError(operation: string): Error {
    const origin =
        typeof window !== 'undefined' && window.location && typeof window.location.origin === 'string'
            ? window.location.origin
            : 'unknown';
    const secureContext =
        typeof (globalThis as any).isSecureContext === 'boolean' ? (globalThis as any).isSecureContext : undefined;
    const secureContextSuffix =
        typeof secureContext === 'boolean' ? ` (isSecureContext=${secureContext ? 'true' : 'false'})` : '';

    return new Error(
        [
            `WebCrypto SubtleCrypto is unavailable; cannot ${operation}.`,
            `On web, SubtleCrypto is restricted to secure contexts: HTTPS or http://localhost (loopback).`,
            `Current origin: ${origin}${secureContextSuffix}.`,
            `If you're opening the UI via a LAN IP (e.g. http://192.168.x.x), use HTTPS or access via localhost.`,
        ].join(' ')
    );
}

export async function digest(algorithm: DigestAlgorithm, data: Uint8Array): Promise<Uint8Array> {
    if (isWebRuntime() && !hasWebCryptoSubtleDigest()) {
        throw createWebCryptoUnavailableError(`compute a ${algorithm} digest`);
    }

    const expoAlgo =
        algorithm === 'SHA-256'
            ? ExpoCrypto.CryptoDigestAlgorithm.SHA256
            : ExpoCrypto.CryptoDigestAlgorithm.SHA512;
    // `expo-crypto` expects `BufferSource` (ArrayBuffer-backed views). Some TS libs model `Uint8Array`
    // as possibly backed by `SharedArrayBuffer`, so copy to a plain `ArrayBuffer`-backed view.
    const safeData = new Uint8Array(data);
    try {
        const out = await ExpoCrypto.digest(expoAlgo, safeData);
        return new Uint8Array(out);
    } catch (e) {
        // `expo-crypto`'s web implementation uses `window.crypto.subtle.digest`, which fails on insecure origins
        // (e.g. http://LAN-IP). In that case it can throw a low-signal TypeError like:
        // "undefined is not an object (evaluating 'getCrypto().subtle.digest')".
        if (isWebRuntime() && !hasWebCryptoSubtleDigest()) {
            throw createWebCryptoUnavailableError(`compute a ${algorithm} digest`);
        }
        throw e;
    }
}
