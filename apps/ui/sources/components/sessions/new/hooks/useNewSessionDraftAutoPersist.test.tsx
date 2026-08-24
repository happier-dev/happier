// @vitest-environment jsdom

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT } from '@/components/ui/forms/largeTextInputPolicy';

import { useNewSessionDraftAutoPersist } from './useNewSessionDraftAutoPersist';

/**
 * A draft-text source whose length never changes and which never notifies — the
 * out-of-render text signal is exercised separately in `emits`-driven cases below.
 */
function staticDraftText(length: number) {
    return {
        getLength: () => length,
        subscribe: () => () => {},
    } as const;
}

const appStateChangeListeners = new Set<(state: string) => void>();

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            OS: 'web',
        },
        AppState: {
            ...actual.AppState,
            currentState: 'active',
            addEventListener: vi.fn((eventName: string, listener: (state: string) => void) => {
                if (eventName === 'change') appStateChangeListeners.add(listener);
                return {
                    remove: () => appStateChangeListeners.delete(listener),
                };
            }),
        },
    };
});

describe('useNewSessionDraftAutoPersist', () => {
    it('does not materialize an untouched draft when mount persistence is disabled', async () => {
        const persistDraftNow = vi.fn();

        vi.useFakeTimers();
        try {
            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                    persistOnMount: false,
                    draftText: staticDraftText(0),
                }),
            );

            await vi.advanceTimersByTimeAsync(5_000);
            await hook.unmount();
            expect(persistDraftNow).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('flushes pending draft persistence immediately when the app backgrounds', async () => {
        const persistDraftNow = vi.fn();

        vi.useFakeTimers();
        try {
            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                    draftText: staticDraftText(10),
                }),
            );

            for (const listener of appStateChangeListeners) listener('background');

            expect(persistDraftNow).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(persistDraftNow).toHaveBeenCalledTimes(1);
            await hook.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('flushes a large web draft immediately on pagehide instead of waiting for idle', async () => {
        const persistDraftNow = vi.fn();
        const idleCallbacks: Array<() => void> = [];
        const originalRequestIdleCallback = globalThis.requestIdleCallback;
        const originalCancelIdleCallback = globalThis.cancelIdleCallback;

        globalThis.requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
            idleCallbacks.push(() => callback({ didTimeout: false, timeRemaining: () => 10 }));
            return idleCallbacks.length;
        });
        globalThis.cancelIdleCallback = vi.fn();

        vi.useFakeTimers();
        try {
            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                    draftText: staticDraftText(WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT + 1),
                }),
            );

            window.dispatchEvent(new Event('pagehide'));

            expect(persistDraftNow).toHaveBeenCalledTimes(1);
            expect(idleCallbacks).toHaveLength(0);
            await hook.unmount();
        } finally {
            vi.useRealTimers();
            globalThis.requestIdleCallback = originalRequestIdleCallback;
            globalThis.cancelIdleCallback = originalCancelIdleCallback;
        }
    });

    it('flushes the pending persist callback on unmount', async () => {
        const persistDraftNow = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionDraftAutoPersist({
                persistDraftNow,
            }),
        );

        // Unmount before the debounce timer fires.
        await hook.unmount();

        expect(persistDraftNow).toHaveBeenCalledTimes(1);
    });

    it('does not flush a pending persist callback after persistence is disabled', async () => {
        const persistDraftNow = vi.fn();
        let persistenceEnabled = true;

        vi.useFakeTimers();
        try {
            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                    persistenceEnabled,
                }),
            );

            persistenceEnabled = false;
            await hook.rerender();
            await flushHookEffects({ runAllTimers: true });
            await hook.unmount();
        } finally {
            vi.useRealTimers();
        }

        expect(persistDraftNow).not.toHaveBeenCalled();
    });

    it('does not schedule draft persistence while the screen is unfocused', async () => {
        const persistDraftNow = vi.fn();

        vi.useFakeTimers();
        try {
            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                    focused: false,
                    draftText: staticDraftText(10),
                }),
            );

            await vi.advanceTimersByTimeAsync(5_000);
            expect(persistDraftNow).not.toHaveBeenCalled();
            await hook.unmount();
            expect(persistDraftNow).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('flushes pending draft persistence once when the screen loses focus', async () => {
        const persistDraftNow = vi.fn();
        let focused = true;

        vi.useFakeTimers();
        try {
            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                    focused,
                    draftText: staticDraftText(10),
                }),
            );

            // Blur before the debounce deadline: the latest draft must be flushed
            // exactly once so navigation away does not drop recent typing.
            focused = false;
            await hook.rerender();
            expect(persistDraftNow).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(5_000);
            expect(persistDraftNow).toHaveBeenCalledTimes(1);

            await hook.unmount();
            expect(persistDraftNow).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not re-arm the debounce from re-renders that do not change the draft', async () => {
        const persistDraftNow = vi.fn();

        vi.useFakeTimers();
        try {
            const hook = await renderHook(() =>
                // A fresh callback identity every render (matches the real call site).
                useNewSessionDraftAutoPersist({
                    persistDraftNow: () => persistDraftNow(),
                    draftText: staticDraftText(10),
                }),
            );

            await vi.advanceTimersByTimeAsync(200);
            await hook.rerender();
            // The web debounce is 250ms from the ORIGINAL schedule; an unrelated
            // re-render at t=200 must not push the deadline to t=450.
            await vi.advanceTimersByTimeAsync(60);
            expect(persistDraftNow).toHaveBeenCalledTimes(1);

            await hook.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-arms the debounce from a composer text change that does not re-render the owner', async () => {
        const persistDraftNow = vi.fn();
        const stageDraftNow = vi.fn();
        const listeners = new Set<() => void>();
        let textLength = 4;
        const draftText = {
            getLength: () => textLength,
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
        } as const;

        vi.useFakeTimers();
        try {
            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                    stageDraftNow,
                    draftText,
                }),
            );

            await vi.advanceTimersByTimeAsync(200);
            // Keystroke: the store notifies, the owner does not re-render.
            textLength = 5;
            for (const listener of listeners) {
                listener();
            }

            expect(stageDraftNow).toHaveBeenCalledTimes(1);
            expect(persistDraftNow).not.toHaveBeenCalled();

            // 260ms after mount but only 60ms after the keystroke: still debounced.
            await vi.advanceTimersByTimeAsync(60);
            expect(persistDraftNow).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(200);
            expect(persistDraftNow).toHaveBeenCalledTimes(1);

            await hook.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-arms persistence when draft content changes without changing text length', async () => {
        const persistDraftNow = vi.fn();
        const stageDraftNow = vi.fn();
        let draftChangeKey = 'AAAA';

        vi.useFakeTimers();
        try {
            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                    stageDraftNow,
                    draftText: staticDraftText(4),
                    draftChangeKey,
                }),
            );

            await vi.advanceTimersByTimeAsync(250);
            expect(persistDraftNow).toHaveBeenCalledTimes(1);

            draftChangeKey = 'BBBB';
            await hook.rerender();
            expect(stageDraftNow).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(250);

            expect(persistDraftNow).toHaveBeenCalledTimes(2);
            await hook.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('defers large web draft persistence beyond the short debounce and until idle', async () => {
        const persistDraftNow = vi.fn();
        const idleCallbacks: Array<() => void> = [];
        const originalRequestIdleCallback = globalThis.requestIdleCallback;
        const originalCancelIdleCallback = globalThis.cancelIdleCallback;

        globalThis.requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
            idleCallbacks.push(() => callback({ didTimeout: false, timeRemaining: () => 10 }));
            return idleCallbacks.length;
        });
        globalThis.cancelIdleCallback = vi.fn();

        vi.useFakeTimers();
        try {
            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                    draftText: staticDraftText(WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT + 1),
                }),
            );

            await vi.advanceTimersByTimeAsync(250);
            expect(persistDraftNow).not.toHaveBeenCalled();
            expect(idleCallbacks).toHaveLength(0);

            await vi.advanceTimersByTimeAsync(250);
            expect(persistDraftNow).not.toHaveBeenCalled();
            expect(idleCallbacks).toHaveLength(1);

            idleCallbacks[0]?.();
            expect(persistDraftNow).toHaveBeenCalledTimes(1);

            await hook.unmount();
        } finally {
            vi.useRealTimers();
            globalThis.requestIdleCallback = originalRequestIdleCallback;
            globalThis.cancelIdleCallback = originalCancelIdleCallback;
        }
    });

    it('schedules large web draft persistence on unmount without synchronously serializing it', async () => {
        const persistDraftNow = vi.fn();
        const idleCallbacks: Array<() => void> = [];
        const originalRequestIdleCallback = globalThis.requestIdleCallback;
        const originalCancelIdleCallback = globalThis.cancelIdleCallback;

        globalThis.requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
            idleCallbacks.push(() => callback({ didTimeout: false, timeRemaining: () => 10 }));
            return idleCallbacks.length;
        });
        globalThis.cancelIdleCallback = vi.fn();

        vi.useFakeTimers();
        try {
            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                    draftText: staticDraftText(WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT + 1),
                }),
            );

            await hook.unmount();

            expect(persistDraftNow).not.toHaveBeenCalled();
            expect(idleCallbacks).toHaveLength(1);

            idleCallbacks[0]?.();
            expect(persistDraftNow).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
            globalThis.requestIdleCallback = originalRequestIdleCallback;
            globalThis.cancelIdleCallback = originalCancelIdleCallback;
        }
    });

    it('cancels stale large web idle persistence when the draft changes before idle runs', async () => {
        const persistDraftNow = vi.fn();
        const idleCallbacks: Array<() => void> = [];
        const originalRequestIdleCallback = globalThis.requestIdleCallback;
        const originalCancelIdleCallback = globalThis.cancelIdleCallback;

        globalThis.requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
            idleCallbacks.push(() => callback({ didTimeout: false, timeRemaining: () => 10 }));
            return idleCallbacks.length;
        });
        globalThis.cancelIdleCallback = vi.fn();

        vi.useFakeTimers();
        try {
            const draftTextLength = WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT + 1;
            let draftChangeKey = 'large-draft-a';
            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                    draftText: staticDraftText(draftTextLength),
                    draftChangeKey,
                }),
            );

            await vi.advanceTimersByTimeAsync(500);
            expect(idleCallbacks).toHaveLength(1);
            expect(persistDraftNow).not.toHaveBeenCalled();

            draftChangeKey = 'large-draft-b';
            await hook.rerender();

            expect(globalThis.cancelIdleCallback).toHaveBeenCalledWith(1);

            await vi.advanceTimersByTimeAsync(500);
            expect(idleCallbacks).toHaveLength(2);

            idleCallbacks[0]?.();
            idleCallbacks[1]?.();

            expect(persistDraftNow).toHaveBeenCalledTimes(1);

            await hook.unmount();
        } finally {
            vi.useRealTimers();
            globalThis.requestIdleCallback = originalRequestIdleCallback;
            globalThis.cancelIdleCallback = originalCancelIdleCallback;
        }
    });
});
