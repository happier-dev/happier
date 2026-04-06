import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { motionTokens } from '@/components/ui/motion/motionTokens';

const timingSpy = vi.hoisted(() => vi.fn(() => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }) })));
const reduceMotionSpy = vi.hoisted(() => vi.fn(() => false));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Animated: {
            Value: class {
                private value: number;

                constructor(value: number) {
                    this.value = value;
                }

                setValue(value: number) {
                    this.value = value;
                }

                interpolate(config: Record<string, unknown>) {
                    return { kind: 'interpolate', config };
                }
            },
            timing: timingSpy,
            View: (props: React.PropsWithChildren<Record<string, unknown>>) =>
                React.createElement('AnimatedView', props, props.children),
        },
    });
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reduceMotionSpy(),
}));

describe('DesktopActivityOverlayMotionFrame', () => {
    it('animates the desktop overlay frame with the shared motion tokens', async () => {
        const { DesktopActivityOverlayMotionFrame } = await import('./DesktopActivityOverlayMotionFrame');

        await renderScreen(
            <DesktopActivityOverlayMotionFrame visible expanded>
                <div />
            </DesktopActivityOverlayMotionFrame>,
        );

        expect(timingSpy).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
            duration: motionTokens.durationMs.base,
            easing: motionTokens.easing.standard,
            useNativeDriver: false,
        }));
    });

    it('respects reduced motion by skipping the animated duration', async () => {
        reduceMotionSpy.mockReturnValue(true);
        const { DesktopActivityOverlayMotionFrame } = await import('./DesktopActivityOverlayMotionFrame');

        const screen = await renderScreen(
            <DesktopActivityOverlayMotionFrame visible expanded={false}>
                <div />
            </DesktopActivityOverlayMotionFrame>,
        );

        timingSpy.mockClear();

        await act(async () => {
            screen.tree.update(
                <DesktopActivityOverlayMotionFrame visible={false} expanded={false}>
                    <div />
                </DesktopActivityOverlayMotionFrame>,
            );
        });

        expect(timingSpy).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
            duration: motionTokens.durationMs.instant,
            useNativeDriver: false,
        }));
    });
});
