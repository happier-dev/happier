import { afterEach, describe, expect, it } from 'vitest';

import { readWebCryptoSupportSnapshot } from './webCryptoSupport';

type GlobalWithWindow = typeof globalThis & {
    window?: unknown;
    document?: unknown;
};

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');

function setGlobalWindow(value: GlobalWithWindow['window']): void {
    Object.defineProperty(globalThis, 'window', {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
    });
}

function setGlobalDocument(value: unknown): void {
    Object.defineProperty(globalThis, 'document', {
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
    if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).window;
    }

    if (originalDocumentDescriptor) {
        Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
    } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).document;
    }

    if (originalCryptoDescriptor) {
        Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).crypto;
    }
});

describe('platform/webCryptoSupport', () => {
    it('treats browser-like environments without SubtleCrypto as unsupported', () => {
        // Use a minimal window-like shape; cast is intentional for test-only DOM fixtures.
        setGlobalWindow({ location: { origin: 'http://192.168.1.50:8081' } } as any);
        setGlobalDocument({});
        setGlobalCrypto({});

        const snapshot = readWebCryptoSupportSnapshot();
        expect(snapshot.supported).toBe(false);
        expect(snapshot.origin).toBe('http://192.168.1.50:8081');
        expect(snapshot.missing.length).toBeGreaterThan(0);
    });
});
