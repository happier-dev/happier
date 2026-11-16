import { md5 } from '@noble/hashes/legacy';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

const encoder = new TextEncoder();
const bytes = (value: string | Uint8Array) => typeof value === 'string' ? encoder.encode(value) : value;

/** Legacy vendor content checksums only; MD5 is not a security identity. */
export function computeHttpContentMd5Hex(parts: readonly (string | Uint8Array)[]): string {
    const digest = md5.create();
    for (const part of parts) digest.update(bytes(part));
    return bytesToHex(digest.digest());
}

/** Raw HMAC-SHA256 bytes for vendor request-signing protocols. */
export function computeHttpHmacSha256(key: string | Uint8Array, value: string): Uint8Array {
    return hmac(sha256, bytes(key), bytes(value));
}
