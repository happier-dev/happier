import { describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ currentState: 'active' as string }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            get currentState() {
                return appState.currentState;
            },
        },
    });
});

describe('isRuntimeActive', () => {
    it('treats the web appState "unknown" as active (so probes can run)', async () => {
        const { isRuntimeActive } = await import('./isRuntimeActive');
        appState.currentState = 'unknown';
        expect(isRuntimeActive()).toBe(true);
    });

    it('treats the web appState "background" as inactive', async () => {
        const { isRuntimeActive } = await import('./isRuntimeActive');
        appState.currentState = 'background';
        expect(isRuntimeActive()).toBe(false);
    });

    it('treats web document.visibilityState=hidden as inactive', async () => {
        const { isRuntimeActive } = await import('./isRuntimeActive');
        appState.currentState = 'active';
        const prev = (globalThis as any).document;
        (globalThis as any).document = { visibilityState: 'hidden' };
        try {
            expect(isRuntimeActive()).toBe(false);
        } finally {
            (globalThis as any).document = prev;
        }
    });

    it('treats a Tauri webview as active even when document.visibilityState=hidden', async () => {
        const { isRuntimeActive } = await import('./isRuntimeActive');
        appState.currentState = 'active';
        const prev = (globalThis as any).document;
        (globalThis as any).document = { visibilityState: 'hidden' };
        (globalThis as any).__TAURI_INTERNALS__ = { invoke: () => undefined };
        try {
            expect(isRuntimeActive()).toBe(true);
        } finally {
            delete (globalThis as any).__TAURI_INTERNALS__;
            (globalThis as any).document = prev;
        }
    });

    it('treats a Tauri webview as active even when AppState reports background', async () => {
        const { isRuntimeActive } = await import('./isRuntimeActive');
        appState.currentState = 'background';
        const prevDocument = (globalThis as any).document;
        (globalThis as any).document = { visibilityState: 'hidden' };
        (globalThis as any).__TAURI_INTERNALS__ = { invoke: () => undefined };
        try {
            expect(isRuntimeActive()).toBe(true);
        } finally {
            delete (globalThis as any).__TAURI_INTERNALS__;
            (globalThis as any).document = prevDocument;
        }
    });
});
