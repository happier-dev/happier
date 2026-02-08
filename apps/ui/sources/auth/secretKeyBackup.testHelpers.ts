import { encodeBase64 } from '@/encryption/base64';

export function makeSequentialSecretBytes(): Uint8Array {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
        bytes[index] = index;
    }
    return bytes;
}

export function makePatternSecretBytes(multiplier: number, offset: number): Uint8Array {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
        bytes[index] = (index * multiplier + offset) % 256;
    }
    return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
    return encodeBase64(bytes, 'base64url');
}

export const sequentialSecretBytes = makeSequentialSecretBytes();
export const sequentialSecretBase64 = toBase64Url(sequentialSecretBytes);
export const fullFFSecretBytes = new Uint8Array(32).fill(255);
export const fullFFSecretBase64 = toBase64Url(fullFFSecretBytes);
export const patternedSecretBytes = makePatternSecretBytes(7, 13);
export const patternedSecretBase64 = toBase64Url(patternedSecretBytes);
