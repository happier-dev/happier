import * as hex from '@stablelib/hex';
import type { Bytes } from '../../types';

export function decodeHex(hexString: string, format: 'normal' | 'mac' = 'normal'): Bytes {
    if (format === 'mac') {
        const encoded = hexString.replace(/:/g, '');
        return Uint8Array.from(hex.decode(encoded));
    }
    return Uint8Array.from(hex.decode(hexString));
}

export function encodeHex(buffer: Bytes, format: 'normal' | 'mac' = 'normal'): string {
    if (format === 'mac') {
        const encoded = hex.encode(buffer);
        return encoded.match(/.{2}/g)?.join(':') || '';
    }
    return hex.encode(buffer);
}
