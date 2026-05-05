import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    DESKTOP_OVERLAY_CLOSE_SPRING,
    DESKTOP_OVERLAY_OPEN_SPRING,
} from '../motion/desktopOverlaySprings';

const reduceMotionSpy = vi.hoisted(() => vi.fn(() => false));
const withSpringSpy = vi.hoisted(() => vi.fn((value: number) => value));
const withTimingSpy = vi.hoisted(() => vi.fn((value: number) => value));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-reanimated', () => ({
    default: {
        View: (props: React.PropsWithChildren<Record<string, unknown>>) =>
            React.createElement('AnimatedView', props, props.children),
    },
    Easing: {
        out: (value: unknown) => value,
        cubic: 'cubic',
    },
    useAnimatedStyle: <T,>(factory: () => T) => factory(),
    useSharedValue: <T,>(initial: T) => ({ value: initial }),
    withSpring: withSpringSpy,
    withTiming: withTimingSpy,
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reduceMotionSpy(),
}));

describe('DesktopActivityOverlayMotionFrame', () => {
    afterEach(() => {
        vi.useRealTimers();
        reduceMotionSpy.mockReturnValue(false);
    });

    it('uses the desktop open spring token for expanded entry motion', async () => {
        const { DesktopActivityOverlayMotionFrame } = await import('./DesktopActivityOverlayMotionFrame');

        await renderScreen(
            <DesktopActivityOverlayMotionFrame visible expanded>
                <div />
            </DesktopActivityOverlayMotionFrame>,
        );

        expect(withSpringSpy).toHaveBeenCalledWith(1, expect.objectContaining({
            duration: DESKTOP_OVERLAY_OPEN_SPRING.response * 1000,
            dampingRatio: DESKTOP_OVERLAY_OPEN_SPRING.dampingRatio,
        }));
    });

    it('uses the desktop close spring token when exiting collapsed content', async () => {
        const { DesktopActivityOverlayMotionFrame } = await import('./DesktopActivityOverlayMotionFrame');
        const screen = await renderScreen(
            <DesktopActivityOverlayMotionFrame visible expanded={false}>
                <div />
            </DesktopActivityOverlayMotionFrame>,
        );

        withSpringSpy.mockClear();

        await act(async () => {
            screen.tree.update(
                <DesktopActivityOverlayMotionFrame visible={false} expanded={false}>
                    <div />
                </DesktopActivityOverlayMotionFrame>,
            );
        });

        expect(withSpringSpy).toHaveBeenCalledWith(0, expect.objectContaining({
            duration: DESKTOP_OVERLAY_CLOSE_SPRING.response * 1000,
            dampingRatio: DESKTOP_OVERLAY_CLOSE_SPRING.dampingRatio,
        }));
    });

    it('respects reduced motion by using an instant static timing path', async () => {
        reduceMotionSpy.mockReturnValue(true);
        const { DesktopActivityOverlayMotionFrame } = await import('./DesktopActivityOverlayMotionFrame');

        const screen = await renderScreen(
            <DesktopActivityOverlayMotionFrame visible expanded={false}>
                <div />
            </DesktopActivityOverlayMotionFrame>,
        );

        withTimingSpy.mockClear();

        await act(async () => {
            screen.tree.update(
                <DesktopActivityOverlayMotionFrame visible={false} expanded={false}>
                    <div />
                </DesktopActivityOverlayMotionFrame>,
            );
        });

        expect(withTimingSpy).toHaveBeenCalledWith(0, expect.objectContaining({
            duration: 0,
        }));
    });

    it('keeps edge-anchored notch frames pinned without geometric transforms', async () => {
        const { DesktopActivityOverlayMotionFrame } = await import('./DesktopActivityOverlayMotionFrame');

        const screen = await renderScreen(
            <DesktopActivityOverlayMotionFrame visible expanded edgeAnchored>
                <div />
            </DesktopActivityOverlayMotionFrame>,
        );

        const animatedView = screen.tree.root.findByType('AnimatedView' as never);
        const style = Object.assign({}, ...animatedView.props.style);

        expect(style).toEqual(expect.objectContaining({ opacity: 1 }));
        expect(style).not.toHaveProperty('transform');
    });

    it('keeps render-time open progress in flight until the chrome transition completes', async () => {
        vi.useFakeTimers();
        const { DesktopActivityOverlayMotionFrame, useDesktopActivityOverlayMotionProgress } = await import('./DesktopActivityOverlayMotionFrame');

        function Probe(): React.ReactElement {
            const progress = useDesktopActivityOverlayMotionProgress();
            return React.createElement('ProbeView', { progress });
        }

        const screen = await renderScreen(
            <DesktopActivityOverlayMotionFrame visible expanded={false}>
                <Probe />
            </DesktopActivityOverlayMotionFrame>,
        );

        expect(screen.tree.root.findByType('ProbeView' as never).props.progress).toBe(0);

        await act(async () => {
            screen.tree.update(
                <DesktopActivityOverlayMotionFrame visible expanded>
                    <Probe />
                </DesktopActivityOverlayMotionFrame>,
            );
        });

        expect(screen.tree.root.findByType('ProbeView' as never).props.progress).toBe(0);

        await act(async () => {
            vi.advanceTimersByTime((DESKTOP_OVERLAY_OPEN_SPRING.response * 1000) / 2);
        });

        expect(screen.tree.root.findByType('ProbeView' as never).props.progress).toBeGreaterThan(0);
        expect(screen.tree.root.findByType('ProbeView' as never).props.progress).toBeLessThan(1);

        await act(async () => {
            vi.advanceTimersByTime(DESKTOP_OVERLAY_OPEN_SPRING.response * 1000);
        });

        expect(screen.tree.root.findByType('ProbeView' as never).props.progress).toBe(1);
    });
});
