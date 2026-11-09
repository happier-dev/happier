import { afterEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({
    currentState: 'active' as string,
    listeners: new Set<(state: string) => void>(),
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            get currentState() {
                return appState.currentState;
            },
            addEventListener: (_event: string, listener: (state: string) => void) => {
                appState.listeners.add(listener);
                return { remove: () => appState.listeners.delete(listener) };
            },
        },
    });
});

describe('isRuntimeActive', () => {
    afterEach(() => {
        appState.currentState = 'active';
        appState.listeners.clear();
        vi.useRealTimers();
    });

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

    it('pauses hidden desktop work while ignoring misleading native AppState for a visible webview', async () => {
        vi.useFakeTimers();
        const { isRuntimeActive, startRuntimeActiveGatedInterval } = await import('./isRuntimeActive');
        appState.currentState = 'background';
        const listeners = new Set<() => void>();
        const doc = { visibilityState: 'hidden',
            addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
            removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
        };
        vi.stubGlobal('document', doc);
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: () => undefined });
        const tick = vi.fn();
        const stop = startRuntimeActiveGatedInterval(tick, 100);
        try {
            expect(isRuntimeActive()).toBe(false);
            await vi.advanceTimersByTimeAsync(500);
            expect(tick).toHaveBeenCalledTimes(0);
            expect(vi.getTimerCount()).toBe(0);
            doc.visibilityState = 'visible';
            listeners.forEach(listener => listener());
            expect(isRuntimeActive()).toBe(true);
            expect(tick).toHaveBeenCalledTimes(1);
            listeners.forEach(listener => listener());
            expect(tick).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(100);
            expect(tick).toHaveBeenCalledTimes(2);
        } finally {
            stop();
            vi.unstubAllGlobals();
        }
    });

    it('skips interval ticks while inactive and runs once when returning active overdue', async () => {
        vi.useFakeTimers();
        const { startRuntimeActiveGatedInterval } = await import('./isRuntimeActive');
        const tick = vi.fn();

        appState.currentState = 'active';
        const stop = startRuntimeActiveGatedInterval(tick, 100);

        await vi.advanceTimersByTimeAsync(100);
        expect(tick).toHaveBeenCalledTimes(1);

        appState.currentState = 'background';
        appState.listeners.forEach((listener) => listener('background'));
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(500);
        expect(tick).toHaveBeenCalledTimes(1);

        appState.currentState = 'active';
        appState.listeners.forEach((listener) => listener('active'));
        expect(tick).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);

        stop();
        await vi.advanceTimersByTimeAsync(100);
        expect(tick).toHaveBeenCalledTimes(2);
    });

    it('does not arm a timer until an initially inactive runtime becomes active', async () => {
        vi.useFakeTimers();
        const { startRuntimeActiveGatedInterval } = await import('./isRuntimeActive');
        const tick = vi.fn();
        appState.currentState = 'background';
        const stop = startRuntimeActiveGatedInterval(tick, 100);
        try {
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(50);
            appState.currentState = 'active';
            appState.listeners.forEach((listener) => listener('active'));
            expect(tick).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(50);
            expect(tick).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(1);
        } finally {
            stop();
        }
        expect(vi.getTimerCount()).toBe(0);
    });
});
