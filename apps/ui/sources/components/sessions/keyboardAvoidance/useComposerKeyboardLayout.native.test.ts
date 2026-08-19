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
        // A real derived value is recomputed on the UI thread whenever one of its inputs
        // changes, so reads observe the current inputs without a JS render. Model that with a
        // lazy getter over the latest worklet rather than a render-time snapshot.
        useDerivedValue: <T,>(factory: () => T) => {
            const factoryRef = React.useRef(factory);
            factoryRef.current = factory;
            const derived = React.useRef<{ value: T } | null>(null);
            if (!derived.current) {
                derived.current = { get value() { return factoryRef.current(); } } as { value: T };
            }
            return derived.current;
        },
    };
});

describe('useComposerKeyboardLayout native', () => {
    beforeEach(() => {
        standardCleanup();
        nativeHookState.keyboardHandlers = null;
        nativeHookState.keyboardListeners.clear();
        nativeHookState.platformOS = 'android';
        nativeHookState.reanimatedKeyboardHeight = 0;
        nativeHookState.windowHeight = 800;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not subtract the measured composer height from available panel height', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 20,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(200);
        });

        expect(hook.getCurrent().availablePanelHeight.value).toBe(680);
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

    it('uses the measured scaffold height as the viewport for native sheet composers', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 44,
            safeAreaBottom: 34,
        }));
        const layout = hook.getCurrent() as ReturnType<typeof hook.getCurrent> & {
            setScaffoldMeasuredHeight: (height: number) => void;
        };

        expect(layout.setScaffoldMeasuredHeight).toBeTypeOf('function');

        act(() => {
            layout.setScaffoldMeasuredHeight(758);
        });

        expect(hook.getCurrent().availablePanelHeight.value).toBe(724);

        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 335, progress: 1 });
        });

        expect(hook.getCurrent().availablePanelHeight.value).toBe(423);
    });

    it('updates available panel height when the keyboard settles', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 20,
        }));

        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        expect(hook.getCurrent().availablePanelHeight.value).toBe(400);
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
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(220);
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

        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidHide')?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(0);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);
    });

    it('does not resurrect hidden keyboard lift from a stale reanimated closed-frame height', async () => {
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

        nativeHookState.reanimatedKeyboardHeight = 300;
        act(() => {
            nativeHookState.keyboardHandlers?.onMove?.({ height: 0, progress: 0 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(0);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);
        // The continuously tracked inset reads the keyboard animation value directly, so it
        // needs the same post-hide latch: a stale animated height must not re-inflate it.
        expect(hook.getCurrent().listBottomInsetAnimated.value).toBe(140);
    });

    it('does not resurrect hidden keyboard lift from a stale non-zero end frame after iOS hide', async () => {
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

    it('does not resurrect hidden keyboard lift from stale non-zero frames after iOS hide before refocus', async () => {
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

    it('does not let native keyboard hide fallback defeat retained overlay lift', async () => {
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

    it('notifies React bridge subscribers when the keyboard settles', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 20,
        }));
        const heights: number[] = [];
        const unsubscribe = hook.getCurrent().subscribeAvailablePanelHeight?.((height) => {
            heights.push(height);
        });

        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        unsubscribe?.();
        expect(heights.at(-1)).toBe(400);
    });

    it('keeps public inset height current during normal keyboard movement', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 20,
        }));

        act(() => {
            nativeHookState.keyboardHandlers?.onMove?.({ height: 240, progress: 0.8 });
        });

        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(240);
        expect(hook.getCurrent().listBottomInset.value).toBe(240);
    });

    it('notifies list bottom inset subscribers during moving keyboard frames', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));
        const heights: number[] = [];

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(140);
        });
        const unsubscribe = hook.getCurrent().subscribeListBottomInset?.((height) => {
            heights.push(height);
        });

        act(() => {
            nativeHookState.keyboardHandlers?.onMove?.({ height: 300, progress: 1 });
        });

        unsubscribe?.();
        expect(heights.at(-1)).toBe(360);
    });

    it('publishes measured composer height as the initial list bottom inset before keyboard frames arrive', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 0,
        }));
        const heights: number[] = [];
        const unsubscribe = hook.getCurrent().subscribeListBottomInset?.((height) => {
            heights.push(height);
        });

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(125);
        });

        unsubscribe?.();
        expect(hook.getCurrent().listBottomInset.value).toBe(125);
        expect(heights.at(-1)).toBe(125);
    });

    it('does not republish layout when Android repeats the same composer measurement', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 0,
        }));
        const heights: number[] = [];
        const unsubscribe = hook.getCurrent().subscribeListBottomInset?.((height) => {
            heights.push(height);
        });

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(125);
        });
        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(125);
        });

        unsubscribe?.();
        expect(heights).toEqual([0, 125]);
    });

    it('notifies available panel subscribers during moving keyboard frames', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            layoutBottomInset: 80,
            safeAreaBottom: 0,
        }));
        const heights: number[] = [];
        const unsubscribe = hook.getCurrent().subscribeAvailablePanelHeight?.((height) => {
            heights.push(height);
        });

        act(() => {
            nativeHookState.keyboardHandlers?.onMove?.({ height: 300, progress: 1 });
        });

        unsubscribe?.();
        expect(heights.at(-1)).toBe(400);
    });

    it('uses Android native keyboard final-frame events when worklet frames do not arrive', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 0,
        }));

        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidShow')?.({
                endCoordinates: { height: 300 },
            });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(300);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(300);
        expect(hook.getCurrent().availablePanelHeight.value).toBe(400);

        act(() => {
            nativeHookState.keyboardListeners.get('keyboardDidHide')?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().availablePanelHeight.value).toBe(700);
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

    it('marks the scaffold-relative keyboard height helper as a worklet', () => {
        const source = readFileSync(new URL('./useComposerKeyboardLayout.native.ts', import.meta.url), 'utf8');

        expect(source).toMatch(/function resolveKeyboardHeightWithinScaffold[^{]*{\s*['"]worklet['"];/);
    });

    it('rests after modal-owned keyboard events when suppression clears', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(
            ({ keyboardLiftSuppressed }: { keyboardLiftSuppressed: boolean }) => useComposerKeyboardLayout({
                headerHeight: 100,
                keyboardLiftSuppressed,
                safeAreaBottom: 20,
            }),
            { initialProps: { keyboardLiftSuppressed: true } },
        );

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(120);
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });

        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(0);
        expect(hook.getCurrent().bottomInset.value).toBe(20);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);

        await hook.rerender({ keyboardLiftSuppressed: false });

        expect(hook.getCurrent().bottomInset.value).toBe(20);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);
        expect(hook.getCurrent().availablePanelHeight.value).toBe(680);
    });

    it('retains the previous keyboard lift while a composer overlay transfers focus', async () => {
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

        const retention = hook.getCurrent() as unknown as {
            retainKeyboardLift?: () => () => void;
        };
        expect(retention.retainKeyboardLift).toBeTypeOf('function');
        const release = retention.retainKeyboardLift?.();

        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 0, progress: 0 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().listBottomInset.value).toBe(360);

        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 300, progress: 1 });
        });
        act(() => {
            vi.runOnlyPendingTimers();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().listBottomInset.value).toBe(360);

        act(() => {
            release?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);
        expect(hook.getCurrent().listBottomInset.value).toBe(360);
        vi.useRealTimers();
    });

    it('holds the retained lift across a zero-height keyboard hide without a deferred drop', async () => {
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

        // A full keyboard hide while the overlay owns the lift retains the previous lift so
        // focus can transfer without the composer collapsing.
        act(() => {
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 0, progress: 0 });
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);

        // There must be NO deferred correction: letting any pending timers run must not drop
        // the lift on its own. The lift is held until the overlay explicitly releases it.
        act(() => {
            vi.runOnlyPendingTimers();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(220);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(220);

        // Releasing the overlay then settles the lift in one clean step.
        act(() => {
            release?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(0);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);
        expect(hook.getCurrent().listBottomInset.value).toBe(140);
        vi.useRealTimers();
    });

    it('follows decreasing keyboard frames while a composer overlay owns the keyboard lift', async () => {
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
            nativeHookState.keyboardHandlers?.onMove?.({ height: 180, progress: 0.6 });
        });

        // A non-zero decreasing frame must follow the keyboard down, not ratchet to its
        // previous peak. Retention only holds the lift across a full keyboard hide (height 0).
        expect(hook.getCurrent().bottomInset.value).toBe(100);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(100);
        expect(hook.getCurrent().listBottomInset.value).toBe(240);

        act(() => {
            release?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(100);
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(100);
        expect(hook.getCurrent().listBottomInset.value).toBe(240);
    });

    it('tracks the keyboard animation in the animated list inset while the notified inset snaps to its target', async () => {
        // Measured 2026-08-01 on 11 real sends
        // (`.project/reviews/2026-08-01-send-transition/traces/S7.csv` t=25605,
        // `S11.csv` t=22917): the transcript collapsed 258 px in a SINGLE frame at send while
        // the keyboard was still animating away. Every keyboard transition opens with
        // `onStart`, which reports the TARGET frame, so the notified inset reaches its end
        // value before the keyboard has moved a pixel. That total is correct for consumers
        // that must agree on where the content settles; it is the wrong value to render.
        nativeHookState.platformOS = 'ios';
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({ safeAreaBottom: 34 }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(134);
        });
        act(() => {
            nativeHookState.reanimatedKeyboardHeight = -291;
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 291, progress: 1 });
        });

        // At rest both readings agree: they are the same quantity, sampled differently.
        expect(hook.getCurrent().listBottomInset.value).toBe(425);
        expect(hook.getCurrent().listBottomInsetAnimated.value).toBe(425);

        act(() => {
            nativeHookState.keyboardHandlers?.onStart?.({ height: 0, progress: 0 });
        });

        expect(hook.getCurrent().listBottomInset.value).toBe(168);
        // The keyboard has not moved yet, so the rendered spacer must not have moved either.
        expect(hook.getCurrent().listBottomInsetAnimated.value).toBe(425);

        // Mid-dismissal frames are produced by the keyboard animation on the UI thread, with no
        // JS notification in between — the JS thread is busy committing the send.
        nativeHookState.reanimatedKeyboardHeight = -145;
        expect(hook.getCurrent().listBottomInsetAnimated.value).toBe(279);

        nativeHookState.reanimatedKeyboardHeight = 0;
        expect(hook.getCurrent().listBottomInsetAnimated.value).toBe(168);
    });

    // The interactive-dismiss freeze is what makes the transcript hold still while the keyboard
    // is dragged down under the finger: the composer follows the finger, the list does not
    // reflow 60x/s beneath it. It had no coverage at this owner, so the guard below pins the
    // contract that the freeze is REAL, and the test after it pins that the freeze is not a
    // LATCH. Both are needed: a fix that simply deletes the freeze passes the second and fails
    // this one.
    it('holds the transcript inset while an interactive dismissal is still in flight', async () => {
        nativeHookState.platformOS = 'ios';
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({ safeAreaBottom: 34 }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(110);
        });
        act(() => {
            nativeHookState.reanimatedKeyboardHeight = -292;
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 292, progress: 1 });
        });
        act(() => {
            nativeHookState.keyboardHandlers?.onInteractive?.({ height: 292, progress: 1 });
        });
        act(() => {
            nativeHookState.reanimatedKeyboardHeight = -150;
            nativeHookState.keyboardHandlers?.onMove?.({ height: 150, progress: 0.51 });
        });

        // The composer seat follows the finger...
        expect(hook.getCurrent().bottomInset.value).toBe(150);
        // ...while the transcript inset stays where the keyboard left it.
        expect(hook.getCurrent().keyboardHeightForInset.value).toBe(292);
        expect(hook.getCurrent().listBottomInset.value).toBe(110 + 292);
        expect(hook.getCurrent().listBottomInsetAnimated.value).toBe(110 + 292);
    });

    // MEASURED 2026-08-08 (`.project/reviews/2026-08-08-sigsegv/evidence/raw/raw_WD02r.json` and
    // three siblings): in 4/32 graded device sends the transcript's bottom spacer collapsed
    // correctly and then RE-EXPANDED by exactly 258 px (the keyboard height minus the safe area)
    // and stayed there, with the composer provably docked and motionless across the whole window.
    // That is this shape: the interactive-dismiss freeze outliving the keyboard.
    //
    // `keyboardDidHide` is the one signal that says the keyboard is GONE, and retention discards
    // it wholesale. Retention's job is to keep the composer at the lifted SEAT across a hide; it
    // is not a reason to keep believing an interactive dismissal is still under way. Once the
    // freeze survives the hide nothing can release it — `onStart`/`onEnd` only arrive while the
    // keyboard is moving, and it has stopped — so the transcript keeps a keyboard-sized inset
    // with the composer docked, permanently, until the composer is refocused.
    it('releases the interactive-dismiss inset freeze when the keyboard hides behind a retained lift', async () => {
        nativeHookState.platformOS = 'ios';
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.native');
        const hook = await renderHook(() => useComposerKeyboardLayout({ safeAreaBottom: 34 }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(110);
        });
        act(() => {
            nativeHookState.reanimatedKeyboardHeight = -292;
            nativeHookState.keyboardHandlers?.onEnd?.({ height: 292, progress: 1 });
        });

        // A composer chip popover opens and takes the lift (useAgentInputSelectionOverlayController).
        const release = hook.getCurrent().retainKeyboardLift?.();

        // The keyboard is dismissed interactively and ends up gone. `onInteractive` never reports
        // a zero position — react-native-keyboard-controller returns early on `position == 0`
        // (ios/observers/movement/observer/KeyboardMovementObserver+Interactive.swift:41) — so the
        // last frame this handler ever sees is a small non-zero one.
        act(() => {
            nativeHookState.keyboardHandlers?.onInteractive?.({ height: 292, progress: 1 });
        });
        act(() => {
            nativeHookState.reanimatedKeyboardHeight = -5;
            nativeHookState.keyboardHandlers?.onInteractive?.({ height: 5, progress: 0.02 });
        });
        act(() => {
            nativeHookState.reanimatedKeyboardHeight = 0;
            nativeHookState.keyboardListeners.get('keyboardDidHide')?.();
        });

        // The mirror shape: the composer is correctly docked at the safe area...
        expect(hook.getCurrent().bottomInset.value).toBe(34);
        // ...so the transcript must be too, on both readings of the same quantity.
        expect(hook.getCurrent().listBottomInset.value).toBe(110 + 34);
        expect(hook.getCurrent().listBottomInsetAnimated.value).toBe(110 + 34);

        act(() => {
            release?.();
        });

        expect(hook.getCurrent().bottomInset.value).toBe(34);
        expect(hook.getCurrent().listBottomInset.value).toBe(110 + 34);
        expect(hook.getCurrent().listBottomInsetAnimated.value).toBe(110 + 34);
    });
});
