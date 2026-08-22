import { act } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const nativeHookState = vi.hoisted(() => ({
    keyboardHandlers: null as null | {
        onEnd?: (event: { height: number; progress: number }) => void;
        onInteractive?: (event: { height: number; progress: number }) => void;
        onMove?: (event: { height: number; progress: number }) => void;
        onStart?: (event: { height: number; progress: number }) => void;
    },
    keyboardListeners: new Map<string, (event?: { endCoordinates?: { height?: number; screenY?: number } }) => void>(),
    platformOS: 'android' as 'android' | 'ios',
    reanimatedKeyboardHeight: 0,
    windowHeight: 800,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Keyboard: {
            addListener: (eventName: string, listener: (event?: { endCoordinates?: { height?: number; screenY?: number } }) => void) => {
                nativeHookState.keyboardListeners.set(eventName, listener);
                return {
                    remove: () => {
                        nativeHookState.keyboardListeners.delete(eventName);
                    },
                };
            },
        },
        Platform: {
            get OS() {
                return nativeHookState.platformOS;
            },
            select: <T,>(options: { android?: T; default?: T; native?: T; ios?: T; web?: T }) => (
                nativeHookState.platformOS === 'ios'
                    ? options.ios ?? options.native ?? options.default ?? options.android ?? options.web
                    : options.android ?? options.native ?? options.default ?? options.ios ?? options.web
            ),
        },
        useWindowDimensions: () => ({
            width: 390,
            height: nativeHookState.windowHeight,
            scale: 1,
            fontScale: 1,
        }),
    });
});

vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardHandler: (handlers: NonNullable<typeof nativeHookState.keyboardHandlers>) => {
        nativeHookState.keyboardHandlers = handlers;
    },
    useReanimatedKeyboardAnimation: () => ({
        height: {
            get value() {
                return nativeHookState.reanimatedKeyboardHeight;
            },
        },
        progress: { value: 0 },
    }),
}));

vi.mock('react-native-reanimated', async () => {
    const React = await import('react');
    return {
        runOnJS: (callback: (...args: readonly unknown[]) => void) => callback,
        useSharedValue: <T,>(value: T) => React.useRef({ value }).current,
    };
});

describe('useComposerKeyboardLayout native', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    beforeEach(() => {
        standardCleanup();
        nativeHookState.keyboardHandlers = null;
        nativeHookState.keyboardListeners.clear();
        nativeHookState.platformOS = 'android';
        nativeHookState.reanimatedKeyboardHeight = 0;
        nativeHookState.windowHeight = 800;
    });

    it('normalizes keyboard lift relative to the layout below the scaffold', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        expect(hook.getCurrent().availablePanelHeight.value).toBe(620);

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(220);
        expect(hook.getCurrent().listBottomInset.value).toBe(360);
        expect(hook.getCurrent().availablePanelHeight.value).toBe(400);
    });

    it('keeps the composer at rest during zero-progress keyboard start frames', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 20,
        }));

        act(() => {
            nativeHookState.keyboardHandlers?.onStart?.({ height: 300, progress: 0 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(20);
    });

    it('keeps the existing keyboard lift during Android zero-progress start frames while the keyboard is already open', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().listBottomInset.value).toBe(360);

        act(() => {
            nativeHookState.keyboardHandlers?.onStart?.({ height: 0, progress: 0 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().listBottomInset.value).toBe(360);
    });

    it('collapses iOS keyboard lift on zero-progress start frames after programmatic blur', async () => {
        nativeHookState.platformOS = 'ios';
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onStart?.({ height: 0, progress: 0 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(0);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);
    });

    it('does not resurrect hidden iOS keyboard lift from a stale reanimated closed-frame height', async () => {
        nativeHookState.platformOS = 'ios';
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 0, progress: 0 });
        });

        nativeHookState.reanimatedKeyboardHeight = 300;
        act(() => {
            nativeHookState.keyboardHandlers?.onMove?.({ height: 0, progress: 0 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(0);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);
    });

    it('collapses iOS keyboard lift when the native keyboard hide event fires', async () => {
        nativeHookState.platformOS = 'ios';
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });
        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidHide')?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(0);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);
    });

    it('does not resurrect hidden iOS keyboard lift from a stale non-zero end frame after native hide', async () => {
        nativeHookState.platformOS = 'ios';
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });
        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidHide')?.();
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(0);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);
    });

    it('does not resurrect hidden iOS keyboard lift from stale non-zero frames after native hide before refocus', async () => {
        nativeHookState.platformOS = 'ios';
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });
        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidHide')?.();
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onStart?.({ height: 300, progress: 1 });
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(0);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);
    });

    it('allows the next iOS keyboard sequence to lift after composer refocus follows hide', async () => {
        nativeHookState.platformOS = 'ios';
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });
        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidHide')?.();
        });
        act(() => {
            hook.getCurrent().setComposerInputFocused?.(true);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onStart?.({ height: 300, progress: 1 });
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(220);
        expect(hook.getCurrent().listBottomInset.value).toBe(360);
    });

    /**
     * The keyboard can leave and come back WITHOUT the composer ever losing first responder — a
     * transient system presentation over a focused field (the edit/Paste bubble), an interactive
     * dismiss that springs back, a hardware-keyboard toggle, or background/foreground. No `onFocus`
     * fires in any of those, so a gate that only opens on a fresh focus event stays shut and every
     * keyboard worklet keeps early-returning: `bottomInset` never rises, and the composer — which is
     * absolutely positioned at `bottom: 0` and lifted only by `translateY: -bottomInset` — stays
     * parked behind the keyboard until the user blurs and refocuses it.
     */
    it('lifts again when the keyboard returns and the composer never lost focus', async () => {
        nativeHookState.platformOS = 'ios';
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            hook.getCurrent().setComposerInputFocused?.(true);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);

        // The keyboard settles hidden. The composer is NOT blurred.
        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidHide')?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);

        // It comes back on its own. There is no second focus event to re-open the gate.
        act(() => {
            nativeHookState.keyboardHandlers?.onStart?.({ height: 300, progress: 1 });
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
    });

    it('does not let the native keyboard hide fallback defeat retained overlay lift', async () => {
        nativeHookState.platformOS = 'ios';
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });
        const release = hook.getCurrent().retainKeyboardLift?.();
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 0, progress: 0 });
        });
        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidHide')?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(220);
        expect(hook.getCurrent().listBottomInset.value).toBe(360);

        act(() => {
            release?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(0);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);
    });

    it('retains previous keyboard lift while a composer overlay transfers focus', async () => {
        vi.useFakeTimers();
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        const release = hook.getCurrent().retainKeyboardLift?.();

        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 0, progress: 0 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(220);
        expect(hook.getCurrent().listBottomInset.value).toBe(360);
        expect(hook.getCurrent().availablePanelHeight.value).toBe(400);

        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
            vi.runOnlyPendingTimers();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(220);

        act(() => {
            release?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(220);
    });

    it('drops retained keyboard lift after a zero-height keyboard hide settles while the overlay stays open', async () => {
        vi.useFakeTimers();
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        hook.getCurrent().retainKeyboardLift?.();

        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 0, progress: 0 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(220);

        act(() => {
            vi.runOnlyPendingTimers();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(0);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);
        expect(hook.getCurrent().availablePanelHeight.value).toBe(620);
    });

    it('caps available panel height to the measured scaffold container', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            availablePanelMaxHeight: 420,
            headerHeight: 100,
            safeAreaBottom: 20,
        }));

        expect(hook.getCurrent().availablePanelHeight.value).toBe(420);
    });

    it('uses Android final-frame screenY when event height under-reports the visible keyboard top', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 0,
        }));

        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidShow')?.({
                endCoordinates: {
                    height: 300,
                    screenY: 470,
                },
            });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(330);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(330);
        expect(hook.getCurrent().availablePanelHeight.value).toBe(370);
    });

    it('uses the latest viewport height for Android final-frame screenY after resize', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 0,
        }));

        nativeHookState.windowHeight = 900;
        await hook.rerender();

        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidShow')?.({
                endCoordinates: {
                    height: 300,
                    screenY: 500,
                },
            });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(400);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(400);
        expect(hook.getCurrent().availablePanelHeight.value).toBe(400);
    });

    // The interactive-dismiss freeze is what makes the transcript hold still while the keyboard is
    // dragged down under the finger: the composer follows the finger, the list does not reflow
    // 60x/s beneath it. `onInteractive` had NO coverage at this owner in either repo, which is how
    // remote-dev regressed the freeze's release into a permanent transcript inset (measured on
    // device 2026-08-08). Below is the positive contract: the freeze must hold while the gesture
    // is in flight. The case after it is the negative one — it must not outlive the keyboard.
    it('holds the transcript inset while an interactive dismissal is still in flight', async () => {
        nativeHookState.platformOS = 'ios';
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({ safeAreaBottom: 34 }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(110);
        });
        act(() => {
            nativeHookState.reanimatedKeyboardHeight = 292;
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 292, progress: 1 });
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onInteractive?.({ height: 292, progress: 1 });
        });
        act(() => {
            nativeHookState.reanimatedKeyboardHeight = 150;
            nativeHookState.keyboardHandlers?.onMove?.({ height: 150, progress: 0.51 });
        });

        // The composer seat follows the finger...
        expect(hook.getCurrent().bottomInset.value).toBe(150);
        // ...while the transcript inset stays where the keyboard left it.
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(292);
        expect(hook.getCurrent().listBottomInset.value).toBe(110 + 292);
    });

    // An interactive dismissal that runs to completion leaves the keyboard already at rest, so the
    // keyboard animation never restarts and `onStart`/`onEnd` never arrive. `keyboardDidHide` is
    // then the ONLY report that the keyboard settled — and while an overlay holds the lift, the
    // listener discarded it outright. Nothing else can release the interactive-dismiss freeze or
    // schedule the retained-hide drop, so the composer stays seated at a keyboard height that no
    // longer exists and the transcript stays inset for it, until the overlay closes.
    it('settles a retained keyboard lift when the keyboard hides without a closing animation frame', async () => {
        vi.useFakeTimers();
        nativeHookState.platformOS = 'ios';
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        act(() => {
            nativeHookState.reanimatedKeyboardHeight = 300;
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        const release = hook.getCurrent().retainKeyboardLift?.();

        // The overlay drags the keyboard away interactively and lets it go. The gesture reports
        // partial heights and then simply stops; no closing animation follows it.
        act(() => {
            nativeHookState.keyboardHandlers?.onInteractive?.({ height: 300, progress: 1 });
        });
        act(() => {
            nativeHookState.reanimatedKeyboardHeight = 120;
            nativeHookState.keyboardHandlers?.onInteractive?.({ height: 120, progress: 0.4 });
        });

        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(220);

        act(() => {
            nativeHookState.reanimatedKeyboardHeight = 0;
            nativeHookState.keyboardListeners.get('keyboardDidHide')?.();
        });
        act(() => {
            vi.runOnlyPendingTimers();
        });

        // The overlay is still open, so nothing but the settled hide can have done this.
        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(0);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);

        // ...and the mid-gesture height is not resurrected when the overlay finally closes.
        act(() => {
            release?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(0);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);
    });

    it('marks the scaffold-relative keyboard height helper as a worklet', () => {
        const source = readFileSync(new URL('./useComposerKeyboardLayout.native.ts', import.meta.url), 'utf8');

        expect(source).toMatch(/function resolveKeyboardHeightWithinScaffold[^{]*{\s*['"]worklet['"];/);
    });
});
