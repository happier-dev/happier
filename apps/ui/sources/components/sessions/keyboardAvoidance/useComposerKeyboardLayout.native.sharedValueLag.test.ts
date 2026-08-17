import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

// Reanimated 4 guest-runtime semantics: `sharedValue.value = x` dispatches an ASYNC write
// (`setAsync`), while `sharedValue.value` reads return the last synchronized value. A JS
// write immediately followed by a JS read therefore observes the PREVIOUS value. This
// harness models that lag: writes land in `pending` and become readable only after
// `flushSharedValues()`. The layout hook must never depend on write-then-read freshness —
// subscriber notifications must carry the freshly computed local value.
// (Live evidence 2026-07-09: composer growth 137→153→172 notified 404→404→420 instead of
// 404→420→439, leaving the transcript composer inset one step behind and the last rows
// rendered under the composer on native iOS.)
//
// SCOPE — read before adding a test here. This suite pins ONE contract: what the JS thread
// NOTIFIES and REPLAYS. It cannot pin rendered geometry: `keyboardAnimation.height` is frozen at
// 0 in this file's mock, and the rendered spacer is re-derived where the write lag does not
// exist. Every test below must die under a read-back mutant (a recompute reading `.value`
// instead of the JS-owned record; a notify or a subscribe replay carrying `.value` instead of
// the freshly computed local). A test that survives all of those is asserting nothing this suite
// owns.
//
// The UI-thread side — the interactive-dismiss freeze, the post-hide latch, retained lift — is
// pinned in `useComposerKeyboardLayout.native.test.ts`, which drives `reanimatedKeyboardHeight`.
// A dismissal-shaped test written HERE looks like it grades the device shape and does not: the
// mirror test deleted on 2026-08-09 passed with the freeze deleted AND with the post-hide latch
// deleted (both MEASURED on these bytes).

const lagState = vi.hoisted(() => ({
    keyboardHandlers: null as null | {
        onEnd?: (event: { height: number; progress: number }) => void;
        onInteractive?: (event: { height: number; progress: number }) => void;
        onMove?: (event: { height: number; progress: number }) => void;
        onStart?: (event: { height: number; progress: number }) => void;
    },
    keyboardListeners: new Map<string, (event?: { endCoordinates?: { height?: number; screenY?: number } }) => void>(),
    laggingValues: [] as Array<{ commit: () => void }>,
    platformOS: 'android' as 'android' | 'ios',
}));

function flushSharedValues(): void {
    for (const value of lagState.laggingValues) {
        value.commit();
    }
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Keyboard: {
            addListener: (eventName: string, listener: (event?: { endCoordinates?: { height?: number; screenY?: number } }) => void) => {
                lagState.keyboardListeners.set(eventName, listener);
                return {
                    remove: () => {
                        lagState.keyboardListeners.delete(eventName);
                    },
                };
            },
        },
        Platform: {
            get OS() {
                return lagState.platformOS;
            },
            select: <T,>(options: { android?: T; default?: T; native?: T; ios?: T; web?: T }) => (
                lagState.platformOS === 'ios'
                    ? options.ios ?? options.native ?? options.default ?? options.android ?? options.web
                    : options.android ?? options.native ?? options.default ?? options.ios ?? options.web
            ),
        },
        useWindowDimensions: () => ({ width: 390, height: 800, scale: 1, fontScale: 1 }),
    });
});

vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardHandler: (handlers: NonNullable<typeof lagState.keyboardHandlers>) => {
        lagState.keyboardHandlers = handlers;
    },
    useReanimatedKeyboardAnimation: () => ({
        height: { value: 0 },
        progress: { value: 0 },
    }),
}));

vi.mock('react-native-reanimated', async () => {
    const React = await import('react');
    return {
        runOnJS: (callback: (...args: readonly unknown[]) => void) => callback,
        useSharedValue: <T,>(initial: T) => {
            const ref = React.useRef<{ value: T } | null>(null);
            if (ref.current === null) {
                let committed = initial;
                let pending = initial;
                const lagging = {
                    get value(): T {
                        return committed;
                    },
                    set value(next: T) {
                        pending = next;
                    },
                };
                lagState.laggingValues.push({
                    commit: () => {
                        committed = pending;
                    },
                });
                ref.current = lagging;
            }
            return ref.current;
        },
    };
});

describe('useComposerKeyboardLayout native (guest-runtime shared-value write lag)', () => {
    beforeEach(() => {
        standardCleanup();
        lagState.keyboardHandlers = null;
        lagState.keyboardListeners.clear();
        lagState.laggingValues.length = 0;
        lagState.platformOS = 'android';
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('notifies list bottom inset subscribers with the freshly computed value on composer growth', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({ safeAreaBottom: 34 }));
        const received: number[] = [];

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(137);
        });
        flushSharedValues();
        act(() => {
            lagState.keyboardListeners.get('keyboardDidShow')?.({ endCoordinates: { height: 267 } });
        });
        flushSharedValues();

        hook.getCurrent().subscribeListBottomInset?.((height) => {
            received.push(height);
        });
        received.length = 0;

        // Composer grows two steps in quick succession; the async shared-value writes have
        // NOT synchronized between steps. Every notification must still carry the total
        // computed from the writer's own fresh inputs, not a stale read-back.
        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(153);
            hook.getCurrent().setComposerMeasuredHeight(172);
        });

        expect(received).toContain(153 + 267);
        expect(received[received.length - 1]).toBe(172 + 267);
    });

    it('notifies the freshly derived inset when the settled keyboard height lands from JS', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({ safeAreaBottom: 34 }));
        const received: number[] = [];

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(137);
        });
        flushSharedValues();

        hook.getCurrent().subscribeListBottomInset?.((height) => {
            received.push(height);
        });
        received.length = 0;

        // Settled keyboard height arrives via the JS listener; no shared-value flush in
        // between: the notification must reflect the just-received keyboard height.
        act(() => {
            lagState.keyboardListeners.get('keyboardDidShow')?.({ endCoordinates: { height: 267 } });
        });

        expect(received[received.length - 1]).toBe(137 + 267);
    });

    // Measured 2026-08-08 across a 25-send device QA: ~36% of sends left the composer drawn
    // over the transcript at the keyboard-raised seat, permanently. It reproduces with no send
    // and never with the keyboard already down, so the trigger is the DISMISSAL, and the send
    // only supplies the JS-thread stall (2-4.5 s) that keeps the hide writes unsynchronized.
    it('seats the composer at the safe area when a composer measurement lands before the hide writes synchronize', async () => {
        lagState.platformOS = 'ios';
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({ safeAreaBottom: 34 }));
        const notifiedInsets: number[] = [];

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(137);
        });
        flushSharedValues();
        act(() => {
            lagState.keyboardHandlers?.onStart?.({ height: 267, progress: 1 });
        });
        flushSharedValues();
        act(() => {
            lagState.keyboardHandlers?.onEnd?.({ height: 267, progress: 1 });
        });
        flushSharedValues();

        expect(hook.getCurrent().bottomInset.value).toBe(267);

        hook.getCurrent().subscribeListBottomInset?.((height) => {
            notifiedInsets.push(height);
        });
        notifiedInsets.length = 0;

        // The keyboard dismisses: its hide frames run on the UI thread and `keyboardDidHide`
        // settles the layout to a closed keyboard. The JS thread is behind, so NONE of those
        // writes has synchronized when the composer's own layout pass — it shrinks as the draft
        // clears — is processed next.
        act(() => {
            lagState.keyboardHandlers?.onStart?.({ height: 0, progress: 0 });
            lagState.keyboardHandlers?.onEnd?.({ height: 0, progress: 0 });
            lagState.keyboardListeners.get('keyboardDidHide')?.();
        });
        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(120);
        });
        flushSharedValues();

        expect(hook.getCurrent().bottomInset.value).toBe(34);
        expect(notifiedInsets[notifiedInsets.length - 1]).toBe(120 + 34);

        // And it must stay seated. The frame replayed here is a STALE NON-ZERO one — the shape
        // the post-hide latch exists to swallow. Replaying a zero frame instead proved nothing:
        // it seats the composer at the safe area whether the latch is armed or not, so the
        // assertion passed with the latch deleted (MEASURED 2026-08-09).
        act(() => {
            lagState.keyboardHandlers?.onEnd?.({ height: 267, progress: 1 });
        });
        flushSharedValues();

        expect(hook.getCurrent().bottomInset.value).toBe(34);
    });

    // DELETED 2026-08-09: 'notifies the docked transcript inset when an interactive dismiss
    // settles before its writes synchronize'. It claimed to pin the mirror shape (transcript
    // keeps the keyboard-sized gap while the composer docks) and pinned nothing of the kind:
    //   1. It asserted the NOTIFIED settled inset, never the rendered spacer.
    //   2. It drove `onInteractive({ height: 0 })`, which react-native-keyboard-controller
    //      1.18.5 provably never emits: `KeyboardMovementObserver+Interactive.swift:41-45`
    //      returns early when `position == 0`.
    //   3. It could not fail. `keyboardDidHide` → `applyFinalKeyboardHeightFromJS(0)` forces
    //      `isInteractiveDismissActive: false` into the recompute, so the freeze is released on
    //      that path whatever the implementation does.
    // MEASURED on these bytes: it passed with the interactive-dismiss freeze deleted and with
    // the post-hide latch deleted. The freeze's real contract is pinned by
    // `useComposerKeyboardLayout.native.test.ts` → 'holds the transcript inset while an
    // interactive dismissal is still in flight', which dies when the freeze is deleted.
});
