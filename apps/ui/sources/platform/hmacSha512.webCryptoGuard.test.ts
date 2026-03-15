import { afterEach, describe, expect, it, vi } from 'vitest';

type GlobalWithWindow = typeof globalThis & {
    window?: unknown;
};

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

function setGlobalWindow(value: GlobalWithWindow['window']): void {
    Object.defineProperty(globalThis, 'window', {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
    });
}

function setGlobalCrypto(value: unknown): void {
    Object.defineProperty(globalThis, 'crypto', {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
    });
}

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).window;
    }

    if (originalCryptoDescriptor) {
        Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).crypto;
    }
});

describe('platform/hmacSha512 (web guard)', () => {
    it('throws a helpful error when WebCrypto SubtleCrypto is unavailable (e.g. http://LAN-IP)', async () => {
        // Use a minimal window-like shape; cast is intentional for test-only DOM fixtures.
        setGlobalWindow({ location: { origin: 'http://192.168.1.50:8081' }, isSecureContext: false } as any);
        setGlobalCrypto({});

        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));

        const expoDigest = vi.fn().mockRejectedValue(
            new TypeError("undefined is not an object (evaluating 'getCrypto().subtle.digest')")
        );
        vi.doMock('expo-crypto', () => ({
            CryptoDigestAlgorithm: { SHA512: 'SHA512' },
            digest: expoDigest,
        }));

        const { hmacSha512 } = await import('./hmacSha512');

        await expect(hmacSha512(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]))).rejects.toThrow(
            /https|localhost|secure/i
        );
    });
});
