import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

import { renderScreen } from '@/dev/testkit';
import { motionTokens } from '@/components/ui/motion/motionTokens';

const animatedValueInitials = vi.hoisted((): number[] => []);
const timingSpy = vi.hoisted(() => vi.fn(() => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }) })));
const reduceMotionSpy = vi.hoisted(() => vi.fn(() => false));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
        },
        Animated: {
            Value: class {
                private value: number;

                constructor(value: number) {
                    this.value = value;
                    animatedValueInitials.push(value);
                }

                setValue(value: number) {
                    this.value = value;
                }

                interpolate(config: Record<string, unknown>) {
                    return { kind: 'interpolate', config, value: this.value };
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

const ORIGINAL_PLATFORM = Platform.OS;

afterEach(() => {
    Platform.OS = ORIGINAL_PLATFORM;
});

function pointerEventsFromStyle(style: unknown): unknown {
    if (Array.isArray(style)) {
        for (let index = style.length - 1; index >= 0; index -= 1) {
            const resolved = pointerEventsFromStyle(style[index]);
            if (resolved !== undefined) return resolved;
        }
        return undefined;
    }
    if (style && typeof style === 'object' && 'pointerEvents' in style) {
        return (style as { pointerEvents?: unknown }).pointerEvents;
    }
    return undefined;
}

describe('OverlayMotionFrame', () => {
    it('starts enter animations from hidden progress on first visible mount', async () => {
        const { OverlayMotionFrame } = await import('./overlayMotion');

        animatedValueInitials.length = 0;
        timingSpy.mockClear();

        await renderScreen(
            <OverlayMotionFrame visible kind="popover">
                <div />
            </OverlayMotionFrame>,
        );

        expect(animatedValueInitials).toEqual([0]);
        expect(timingSpy).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
            toValue: 1,
            duration: motionTokens.overlay.popover.enterMs,
            easing: motionTokens.easing.standard,
            useNativeDriver: false,
        }));
    });

    it('keeps native overlay responder routing on the React Native prop', async () => {
        const { OverlayMotionFrame } = await import('./overlayMotion');
        Platform.OS = 'ios';

        const screen = await renderScreen(
            <OverlayMotionFrame visible kind="popover">
                <div />
            </OverlayMotionFrame>,
        );
        const frame = screen.tree.root.findByType('AnimatedView' as never);

        expect(frame.props.pointerEvents).toBe('auto');
        expect(pointerEventsFromStyle(frame.props.style)).toBeUndefined();
    });
});
