import { decodeBase64 } from '@/encryption/base64';

function isLikelyDecodedPath(value: string): boolean {
    if (!value || value.includes('\0')) return false;
    if (!value.includes('/') && !value.includes('\\')) return false;

    const nonPrintableCount = value.split('').filter((char) => {
        const code = char.charCodeAt(0);
        return code < 32 && code !== 9 && code !== 10 && code !== 13;
    }).length;

    return nonPrintableCount / value.length <= 0.05;
}

function tryDecodeLegacyBase64Path(value: string): string | null {
    try {
        const bytes = decodeBase64(value);
        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        if (decoded.length > 0 && isLikelyDecodedPath(decoded)) {
            return decoded;
        }
    } catch {}
    return null;
}

export function decodeSessionFilePathParam(encodedPath: string): string {
    if (!encodedPath) return '';

    let uriDecoded = encodedPath;
    try {
        uriDecoded = decodeURIComponent(encodedPath);
    } catch {}

    if (uriDecoded !== encodedPath) {
        return uriDecoded;
    }

    // Backward compatibility for older deep links that used base64 route params.
    const legacyDecoded = tryDecodeLegacyBase64Path(encodedPath);
    if (legacyDecoded) {
        return legacyDecoded;
    }

    return encodedPath;
}
