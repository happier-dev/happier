import * as React from 'react';

function staticDraftText(length: number) {
    return {
        getLength: () => length,
        subscribe: () => () => {},
    } as const;
}
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import {
    TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS,
    TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT,
} from '@/components/ui/forms/largeTextInputPolicy';

import {
    resolveNewSessionDraftAutoPersistDelayMs,
    useNewSessionDraftAutoPersist,
} from './useNewSessionDraftAutoPersist';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            OS: 'web',
        },
    };
});

describe('useNewSessionDraftAutoPersist', () => {
    it('uses the shared large-text debounce policy for large web drafts', () => {
        expect(resolveNewSessionDraftAutoPersistDelayMs({
            platformOS: 'web',
            draftTextLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT,
        })).toBe(250);
        expect(resolveNewSessionDraftAutoPersistDelayMs({
            platformOS: 'web',
            draftTextLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1,
        })).toBe(TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS);
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

    it('re-arms persistence when draft content changes without changing text length', async () => {
        const persistDraftNow = vi.fn();
        let draftChangeKey = 'AAAA';

        vi.useFakeTimers();
        try {
            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                    draftText: staticDraftText(4),
                    draftChangeKey,
                }),
            );

            await vi.advanceTimersByTimeAsync(250);
            expect(persistDraftNow).toHaveBeenCalledTimes(1);

            draftChangeKey = 'BBBB';
            await hook.rerender();
            await vi.advanceTimersByTimeAsync(250);

            expect(persistDraftNow).toHaveBeenCalledTimes(2);
            await hook.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    // The composer text lives in a store, so typing no longer re-renders this hook's owner. A
    // store notification is the ONLY signal that the draft changed: without the subscription the
    // debounce never re-arms and typing silently stops being persisted.
    it('re-arms persistence from a store notification, with no re-render of the owner', async () => {
        const persistDraftNow = vi.fn();
        const listeners = new Set<() => void>();
        let text = 'a';
        const draftText = {
            getLength: () => text.length,
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
                    draftText,
                    draftChangeKey: 'stable',
                }),
            );

            await vi.advanceTimersByTimeAsync(250);
            expect(persistDraftNow).toHaveBeenCalledTimes(1);

            // A keystroke: the text changes and subscribers are notified, but nothing re-renders
            // and draftChangeKey is unchanged.
            text = 'ab';
            for (const listener of Array.from(listeners)) {
                listener();
            }
            await vi.advanceTimersByTimeAsync(250);

            expect(persistDraftNow).toHaveBeenCalledTimes(2);
            await hook.unmount();
            expect(listeners.size).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('defers large pending draft persistence on unmount instead of serializing synchronously', async () => {
        const persistDraftNow = vi.fn();
        const largeDraftTextLength = TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1;
        const delayMs = resolveNewSessionDraftAutoPersistDelayMs({
            platformOS: 'web',
            draftTextLength: largeDraftTextLength,
        });
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
                    draftText: staticDraftText(largeDraftTextLength),
                }),
            );

            await hook.unmount();

            expect(persistDraftNow).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(delayMs);
            expect(persistDraftNow).not.toHaveBeenCalled();
            expect(idleCallbacks).toHaveLength(1);

            idleCallbacks[0]?.();
        } finally {
            vi.useRealTimers();
            globalThis.requestIdleCallback = originalRequestIdleCallback;
            globalThis.cancelIdleCallback = originalCancelIdleCallback;
        }

        expect(persistDraftNow).toHaveBeenCalledTimes(1);
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
            const draftTextLength = TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1;
            let draftChangeKey = 'large-draft-a';
            const delayMs = resolveNewSessionDraftAutoPersistDelayMs({
                platformOS: 'web',
                draftTextLength,
            });
            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                    draftText: staticDraftText(draftTextLength),
                    draftChangeKey,
                }),
            );

            await vi.advanceTimersByTimeAsync(delayMs);
            expect(idleCallbacks).toHaveLength(1);
            expect(persistDraftNow).not.toHaveBeenCalled();

            draftChangeKey = 'large-draft-b';
            await hook.rerender();

            expect(globalThis.cancelIdleCallback).toHaveBeenCalledWith(1);

            await vi.advanceTimersByTimeAsync(delayMs);
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
