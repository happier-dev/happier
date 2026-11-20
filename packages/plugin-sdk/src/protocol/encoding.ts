import {
    encodeBase64 as canonicalEncodeBase64,
    decodeBase64 as canonicalDecodeBase64,
    readPaddedBase64DecodedLength as canonicalReadPaddedBase64DecodedLength,
} from '@happier-dev/protocol/crypto/base64';

/** Portable byte encoding projected from the single Protocol implementation. */
export const encodeBase64: (bytes: Uint8Array, variant?: 'base64' | 'base64url') => string = canonicalEncodeBase64;
export const decodeBase64: (value: string, variant?: 'base64' | 'base64url') => Uint8Array = canonicalDecodeBase64;
export const readPaddedBase64DecodedLength: (value: string) => number | null = canonicalReadPaddedBase64DecodedLength;
