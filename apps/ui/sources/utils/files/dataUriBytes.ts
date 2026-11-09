import { decodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';

/** Decode inline file bytes without relying on a platform URL/network handler. */
export function dataUriBytes(uri: string): Uint8Array | null {
    if (!uri.startsWith('data:')) return null;
    const comma = uri.indexOf(',');
    if (comma < 0) return null;
    try {
        const payload = decodeURIComponent(uri.slice(comma + 1));
        return uri.slice(0, comma).split(';').includes('base64') ? decodeBase64(payload) : encodeUTF8(payload);
    } catch {
        return null;
    }
}
