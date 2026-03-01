import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import * as SplashScreen from 'expo-splash-screen';

import { WebCryptoStartupGate } from './WebCryptoStartupGate';

vi.mock('expo-splash-screen', () => ({
    hideAsync: vi.fn(async () => {}),
}));

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

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
    vi.clearAllMocks();
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

describe('WebCryptoStartupGate', () => {
    it('renders an unsupported screen when SubtleCrypto is unavailable', () => {
        // Use a minimal window-like shape; cast is intentional for test-only DOM fixtures.
        setGlobalWindow({ location: { origin: 'http://192.168.1.50:8081' } } as any);
        setGlobalDocument({});
        setGlobalCrypto({});

        let r!: renderer.ReactTestRenderer;
        expect(() => {
            act(() => {
                r = renderer.create(
                    <WebCryptoStartupGate>
                        {React.createElement('View', { testID: 'gate-ok' })}
                    </WebCryptoStartupGate>
                );
            });
        }).not.toThrow();

        expect(() => r.root.findByProps({ testID: 'webcrypto-unsupported' })).not.toThrow();
        expect(() => r.root.findByProps({ testID: 'gate-ok' })).toThrow();
    });

    it('hides the splash screen when SubtleCrypto is unavailable', () => {
        setGlobalWindow({ location: { origin: 'http://192.168.1.50:8081' } } as any);
        setGlobalDocument({});
        setGlobalCrypto({});

        act(() => {
            renderer.create(
                <WebCryptoStartupGate>
                    {React.createElement('View', { testID: 'gate-ok' })}
                </WebCryptoStartupGate>
            );
        });

        expect(vi.mocked(SplashScreen.hideAsync)).toHaveBeenCalled();
    });

    it('renders children when SubtleCrypto is available', () => {
        setGlobalWindow({ location: { origin: 'https://example.test' } } as any);
        setGlobalDocument({});
        setGlobalCrypto({
            subtle: {
                digest: () => Promise.resolve(new ArrayBuffer(0)),
                importKey: () => Promise.resolve({}),
                encrypt: () => Promise.resolve(new ArrayBuffer(0)),
                decrypt: () => Promise.resolve(new ArrayBuffer(0)),
            }
        });

        let r!: renderer.ReactTestRenderer;
        expect(() => {
            act(() => {
                r = renderer.create(
                    <WebCryptoStartupGate>
                        {React.createElement('View', { testID: 'gate-ok' })}
                    </WebCryptoStartupGate>
                );
            });
        }).not.toThrow();

        expect(() => r.root.findByProps({ testID: 'gate-ok' })).not.toThrow();
        expect(() => r.root.findByProps({ testID: 'webcrypto-unsupported' })).toThrow();
    });
});
