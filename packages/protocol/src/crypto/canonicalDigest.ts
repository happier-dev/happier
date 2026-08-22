import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

import { encodeBase64 } from './base64.js';

const textEncoder = new TextEncoder();

export function encodeCanonicalLengthDelimited(
    parts: readonly (string | Uint8Array)[],
): Uint8Array {
    const encodedParts = parts.map((part) => typeof part === 'string' ? textEncoder.encode(part) : part);
    const totalLength = encodedParts.reduce((sum, part) => sum + 4 + part.length, 0);
    const output = new Uint8Array(totalLength);
    const view = new DataView(output.buffer);
    let offset = 0;
    for (const part of encodedParts) {
        view.setUint32(offset, part.length, false);
        offset += 4;
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}

export function computeCanonicalDomainSeparatedDigest(
    domain: string,
    parts: readonly (string | Uint8Array)[],
): string {
    return encodeBase64(sha256(encodeCanonicalLengthDelimited([domain, ...parts])), 'base64url');
}

/**
 * Same canonical domain separation as the portable base64url digest, encoded
 * as lowercase hex for incumbent persisted fingerprint seams.
 */
export function computeCanonicalDomainSeparatedHexDigest(
    domain: string,
    parts: readonly (string | Uint8Array)[],
): string {
    return bytesToHex(sha256(encodeCanonicalLengthDelimited([domain, ...parts])));
}
