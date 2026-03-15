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

describe('platform/digest (web guard)', () => {
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
            CryptoDigestAlgorithm: { SHA256: 'SHA256', SHA512: 'SHA512' },
            digest: expoDigest,
        }));

        const { digest } = await import('./digest');

        await expect(digest('SHA-256', new Uint8Array([1, 2, 3]))).rejects.toThrow(/https|localhost|secure/i);
    });

    it('does not block on native platforms even if a window global exists', async () => {
        // In React Native dev builds, a `window` global may exist, but WebCrypto is not required.
        setGlobalWindow({ location: { origin: 'http://192.168.1.50:8081' } } as any);
        setGlobalCrypto({});

        vi.doMock('react-native', () => ({
            Platform: { OS: 'ios' },
        }));

        const expoDigest = vi.fn().mockResolvedValue(new ArrayBuffer(0));
        vi.doMock('expo-crypto', () => ({
            CryptoDigestAlgorithm: { SHA256: 'SHA256', SHA512: 'SHA512' },
            digest: expoDigest,
        }));

        const { digest } = await import('./digest');

        await expect(digest('SHA-256', new Uint8Array([1, 2, 3]))).resolves.toEqual(new Uint8Array(0));
        expect(expoDigest).toHaveBeenCalledTimes(1);
    });
});
