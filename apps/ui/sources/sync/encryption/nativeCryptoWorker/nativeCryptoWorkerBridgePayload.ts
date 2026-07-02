import { decodeBase64, encodeBase64 } from '@/encryption/base64';

export type CryptoWorkerBridgeByteEstimate = Readonly<{
    items: number;
    decodedBytes: number;
    base64Utf16Bytes: number;
    totalBridgeBytes: number;
}>;

export function bytesToCryptoWorkerBase64(bytes: Uint8Array): string {
    return encodeBase64(bytes, 'base64');
}

export function estimateCryptoWorkerRawBytesBridgeBytes(bytes: Uint8Array): CryptoWorkerBridgeByteEstimate {
    const decodedBytes = bytes.byteLength;
    const base64Utf16Bytes = Math.ceil(decodedBytes / 3) * 4 * 2;
    return {
        items: 1,
        decodedBytes,
        base64Utf16Bytes,
        totalBridgeBytes: decodedBytes + base64Utf16Bytes,
    };
}

export function estimateCryptoWorkerRawBatchBridgeBytes(values: readonly Uint8Array[]): CryptoWorkerBridgeByteEstimate {
    let decodedBytes = 0;
    let base64Utf16Bytes = 0;
    for (const value of values) {
        const estimate = estimateCryptoWorkerRawBytesBridgeBytes(value);
        decodedBytes += estimate.decodedBytes;
        base64Utf16Bytes += estimate.base64Utf16Bytes;
    }
    return {
        items: values.length,
        decodedBytes,
        base64Utf16Bytes,
        totalBridgeBytes: decodedBytes + base64Utf16Bytes,
    };
}

export function cryptoWorkerBase64ToBytes(value: string): Uint8Array | null {
    try {
        return decodeBase64(value, 'base64');
    } catch {
        return null;
    }
}

const LARGE_BASE64_FAST_ESTIMATE_MIN_CHARS = 1024;
const CANONICAL_PADDED_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function estimateLargeBase64DecodedByteLength(value: string): number | null {
    if (value.length < LARGE_BASE64_FAST_ESTIMATE_MIN_CHARS) return null;
    if (value.length % 4 !== 0) return null;
    if (!CANONICAL_PADDED_BASE64_PATTERN.test(value)) return null;

    const lastCode = value.charCodeAt(value.length - 1);
    const secondLastCode = value.charCodeAt(value.length - 2);
    const paddingBytes = lastCode === 61
        ? (secondLastCode === 61 ? 2 : 1)
        : 0;

    return Math.max(0, (value.length / 4) * 3 - paddingBytes);
}

function getCanonicalPaddedBase64PaddingBytes(value: string): number | null {
    if (value.length % 4 !== 0) return null;
    let paddingStart = value.length;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        const isAlphabet =
            (code >= 65 && code <= 90)
            || (code >= 97 && code <= 122)
            || (code >= 48 && code <= 57)
            || code === 43
            || code === 47;
        if (isAlphabet) {
            if (paddingStart !== value.length) return null;
            continue;
        }
        if (code !== 61) return null;
        if (paddingStart === value.length) {
            paddingStart = index;
        }
        if (index < value.length - 2) return null;
    }
    return value.length - paddingStart;
}

function normalizeBase64ForCryptoWorkerEstimate(value: string): string {
    let normalized = value.replace(/\s+/g, '');
    normalized = normalized.replace(/[^A-Za-z0-9+/]/g, '');
    if (normalized.length % 4 === 1) {
        normalized = normalized.slice(0, -1);
    }
    const padding = normalized.length % 4;
    if (padding) {
        normalized += '='.repeat(4 - padding);
    }
    return normalized;
}

function estimateBase64DecodedByteLength(value: string): number {
    const largeFastEstimate = estimateLargeBase64DecodedByteLength(value);
    if (largeFastEstimate !== null) {
        return largeFastEstimate;
    }

    const canonicalPaddingBytes = getCanonicalPaddedBase64PaddingBytes(value);
    if (canonicalPaddingBytes !== null) {
        return Math.max(0, (value.length / 4) * 3 - canonicalPaddingBytes);
    }

    const normalized = normalizeBase64ForCryptoWorkerEstimate(value);
    if (normalized.length === 0) return 0;
    const paddingBytes = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
    return Math.max(0, (normalized.length / 4) * 3 - paddingBytes);
}

export function estimateCryptoWorkerBase64BridgeBytes(value: string): CryptoWorkerBridgeByteEstimate {
    const decodedBytes = estimateBase64DecodedByteLength(value);
    const base64Utf16Bytes = value.length * 2;
    return {
        items: 1,
        decodedBytes,
        base64Utf16Bytes,
        totalBridgeBytes: decodedBytes + base64Utf16Bytes,
    };
}

export function estimateCryptoWorkerBatchBridgeBytes(values: readonly string[]): CryptoWorkerBridgeByteEstimate {
    let decodedBytes = 0;
    let base64Utf16Bytes = 0;
    for (const value of values) {
        const estimate = estimateCryptoWorkerBase64BridgeBytes(value);
        decodedBytes += estimate.decodedBytes;
        base64Utf16Bytes += estimate.base64Utf16Bytes;
    }
    return {
        items: values.length,
        decodedBytes,
        base64Utf16Bytes,
        totalBridgeBytes: decodedBytes + base64Utf16Bytes,
    };
}
