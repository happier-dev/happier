import * as b64 from '@stablelib/base64';
import type { Bytes } from '../../types';

export function decodeBase64(base64: string, encoding: 'base64' | 'base64url' = 'base64'): Bytes {
    if (encoding === 'base64url') {
        return Uint8Array.from(b64.decodeURLSafe(base64));
    }
    return Uint8Array.from(b64.decode(base64));
}

export function encodeBase64(buffer: Bytes, encoding: 'base64' | 'base64url' = 'base64'): string {
    if (encoding === 'base64url') {
        return b64.encodeURLSafe(buffer);
    }
    return b64.encode(buffer);
}
