import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const accessibilityState = vi.hoisted(() => ({
    reduceMotion: false,
    listeners: [] as Array<(enabled: boolean) => void>,
}));

const contentState = vi.hoisted(() => ({
    mounts: 0,
}));

/**
 * The recede is a native gesture's answer, so this runs on a native platform, and the
 * reduced-motion preference is driven through the accessibility boundary its canonical
 * hook listens to rather than by mocking the hook itself.
 */
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        AccessibilityInfo: {
            isReduceMotionEnabled: () => Promise.resolve(accessibilityState.reduceMotion),
            addEventListener: (event: string, listener: (enabled: boolean) => void) => {
                if (event === 'reduceMotionChanged') accessibilityState.listeners.push(listener);
                return { remove: () => {} };
            },
        },
    });
});

function setReducedMotion(enabled: boolean): void {
    accessibilityState.reduceMotion = enabled;
    for (const listener of [...accessibilityState.listeners]) {
        listener(enabled);
    }
}

function SessionContentProbe(): React.ReactElement {
    // Mount-counting on purpose: the whole point of a container-level transform is that
    // the session tree under it is never re-created by the gesture.
    React.useEffect(() => {
        contentState.mounts += 1;
    }, []);
    return React.createElement('SessionContentProbe', { testID: 'session-content-probe' });
}

type Harness = {
    progress?: { value: number };
    rerender?: () => void;
};

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function readContentMotion(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const host = screen.findHostByTestId('session-cockpit-swipe-content');
    const style = flattenStyle(host?.props.style);
    const transform = (style.transform ?? []) as ReadonlyArray<Record<string, number>>;
    return {
        opacity: style.opacity as number | undefined,
        translateX: transform.find((entry) => 'translateX' in entry)?.translateX,
        scale: transform.find((entry) => 'scale' in entry)?.scale,
    };
}

async function renderSwipeContent() {
    const harness: Harness = {};
    const { SessionLateralSwipeContent } = await import('./SessionLateralSwipeContent');
    const { SessionCockpitChromeRegistryProvider, useSessionLateralSwipe } = await import(
        '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry'
    );

    function SwipeContentHarness() {
        const swipe = useSessionLateralSwipe();
        const [, force] = React.useReducer((current: number) => current + 1, 0);
        harness.progress = swipe.progress;
        harness.rerender = force;
        return (
            <SessionLateralSwipeContent>
                <SessionContentProbe />
            </SessionLateralSwipeContent>
        );
    }

    const screen = await renderScreen(
        <SessionCockpitChromeRegistryProvider>
            <SwipeContentHarness />
        </SessionCockpitChromeRegistryProvider>,
    );
    return { harness, screen };
}

describe('SessionLateralSwipeContent', () => {
    afterEach(() => {
        standardCleanup();
        // The preference store keeps ONE process-wide platform listener, so the
        // listener list is not test state to clear — only the value is.
        setReducedMotion(false);
        contentState.mounts = 0;
    });

    it('adds nothing to the session content at rest', async () => {
        const { screen } = await renderSwipeContent();

        expect(screen.findAllHostsByTestId('session-content-probe')).toHaveLength(1);
        expect(readContentMotion(screen)).toEqual({ opacity: 1, translateX: 0, scale: 1 });
    });

    it('recedes the session while the finger travels toward the next session', async () => {
        const { harness, screen } = await renderSwipeContent();

        act(() => {
            // Negative progress travels toward the NEXT session.
            harness.progress!.value = -1;
            harness.rerender!();
        });

        const motion = readContentMotion(screen);
        expect(motion.translateX).toBe(-24);
        expect(motion.opacity).toBeCloseTo(0.45, 5);
        expect(motion.scale).toBeCloseTo(0.985, 5);
    });

    it('recedes the other way toward the previous session', async () => {
        const { harness, screen } = await renderSwipeContent();

        act(() => {
            harness.progress!.value = 0.5;
            harness.rerender!();
        });

        const motion = readContentMotion(screen);
        expect(motion.translateX).toBeCloseTo(12, 5);
        expect(motion.opacity).toBeCloseTo(0.725, 5);
    });

    it('keeps the session subtree mounted across the whole gesture', async () => {
        const { harness, screen } = await renderSwipeContent();

        expect(contentState.mounts).toBe(1);

        act(() => {
            harness.progress!.value = -0.4;
            harness.rerender!();
        });
        act(() => {
            harness.progress!.value = -1;
            harness.rerender!();
        });
        act(() => {
            harness.progress!.value = 0;
            harness.rerender!();
        });

        // A remount here would throw away the transcript the motion exists to protect.
        expect(contentState.mounts).toBe(1);
        expect(screen.findAllHostsByTestId('session-content-probe')).toHaveLength(1);
    });

    it('removes travel and scale under reduced motion, keeping the session itself intact', async () => {
        const { harness, screen } = await renderSwipeContent();

        await act(async () => {
            setReducedMotion(true);
        });
        act(() => {
            harness.progress!.value = 0.5;
            harness.rerender!();
        });

        const motion = readContentMotion(screen);
        expect(motion.translateX).toBe(0);
        expect(motion.scale).toBe(1);
        expect(motion.opacity).toBeCloseTo(0.725, 5);
        expect(screen.findAllHostsByTestId('session-content-probe')).toHaveLength(1);
    });
});
