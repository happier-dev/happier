// Vitest/node stub for `rn-encryption`.
// The real package dynamically selects a native implementation that depends on React Native internals (Flow syntax),
// which isn't compatible with our Vitest node environment.

import * as web from 'web-secure-encryption';

export const {
    generateAESKey,
    encryptAES,
    decryptAES,
    encryptAsyncAES,
    decryptAsyncAES,
    encryptRSA,
    decryptRSA,
    encryptAsyncRSA,
    decryptAsyncRSA,
    generateRSAKeyPair,
    generateHMACKey,
    hmacSHA256,
    hmacSHA512,
    hashSHA256,
    hashSHA512,
    generateRandomString,
    base64Encode,
    base64Decode,
    generateECDSAKeyPair,
    signDataECDSA,
    verifySignatureECDSA,
    getPublicECDSAKey,
} = web;

export function encryptFile(): never {
    throw new Error('encryptFile is not available in Vitest');
}

export function decryptFile(): never {
    throw new Error('decryptFile is not available in Vitest');
}

export function getPublicRSAkey(): never {
    throw new Error('getPublicRSAkey is not available in Vitest');
}

