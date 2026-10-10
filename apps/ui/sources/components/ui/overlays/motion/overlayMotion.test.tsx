import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';
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
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

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
    it('does not fade any ancestor of a real web material backdrop during entrance', async () => {
        const { OverlayMotionFrame } = await import('./overlayMotion');
        const { GlassSurface } = await import('@/components/ui/glass/GlassSurface');
        const screen = await renderScreen(<OverlayMotionFrame visible kind="popover">
            <GlassSurface finishRole={null}><div /></GlassSurface>
        </OverlayMotionFrame>);
        const paint = screen.findAll(node => typeof node.type === 'string'
            && String(flattenTestStyle(node.props.style)?.backdropFilter).includes('blur'))[0]!;
        expect(paint).toBeTruthy();
        // The clock boundary is held at progress 0. Fading any ancestor limits the backdrop
        // to that ancestor's empty plane, so the paint and every ancestor must stay unanimated.
        for (let ancestor = paint.parent; ancestor; ancestor = ancestor.parent) {
            if (typeof ancestor.type !== 'string') continue;
            const style = flattenTestStyle(ancestor.props.style);
            expect(style?.opacity).toBeUndefined();
            expect(style?.transform).toBeUndefined();
        }
    });
    it('starts enter animations from hidden progress on first visible mount', async () => {
        const { resolveOverlayMotionPreset, useOverlayMotionAnimation } = await import('./overlayMotion');
        function Probe() {
            useOverlayMotionAnimation({ visible: true, preset: resolveOverlayMotionPreset({ kind: 'popover' }) });
            return null;
        }

        animatedValueInitials.length = 0;
        timingSpy.mockClear();

        await renderScreen(<Probe />);

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
        expect(flattenTestStyle(frame.props.style)?.transform).toBeDefined();
        expect(timingSpy).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({ useNativeDriver: true }));
    });
});

describe('panel motion', () => {
    it('slides in its own width from the side it stands on, and fades in place under reduced motion', async () => {
        const { resolveOverlayMotionPreset, useOverlayMotionAnimation } = await import('./overlayMotion');
        const preset = resolveOverlayMotionPreset({ kind: 'panel', direction: 'right', travelPx: 320 });
        let style: any = null;
        function Probe() {
            style = useOverlayMotionAnimation({ visible: true, preset }).style;
            return null;
        }

        timingSpy.mockClear();
        await renderScreen(<Probe />);
        expect(timingSpy).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({ toValue: 1, duration: motionTokens.overlay.panel.enterMs }));
        const translateX = style.transform.find((entry: Record<string, unknown>) => 'translateX' in entry).translateX;
        expect(translateX.config.outputRange).toEqual([-320, 0]);
        expect(style.opacity.config.outputRange).toEqual([1, 1]);

        timingSpy.mockClear();
        reduceMotionSpy.mockReturnValue(true);
        try {
            await renderScreen(<Probe />);
            expect(timingSpy).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({ toValue: 1, duration: motionTokens.overlay.panel.reducedMotionFadeMs }));
            expect(style.transform).toBeUndefined();
        } finally {
            reduceMotionSpy.mockReturnValue(false);
        }
    });
});

describe('popover and dialog motion under reduced motion', () => {
    it('becomes a short cross-fade instead of a snap or a scale', async () => {
        const { resolveOverlayMotionPreset, useOverlayMotionAnimation } = await import('./overlayMotion');
        for (const kind of ['popover', 'modal'] as const) {
            const preset = resolveOverlayMotionPreset({ kind, direction: 'bottom' });
            let style: any = null;
            function Probe() {
                style = useOverlayMotionAnimation({ visible: true, preset }).style;
                return null;
            }
            timingSpy.mockClear();
            reduceMotionSpy.mockReturnValue(true);
            try {
                await renderScreen(<Probe />);
                const lastCall = timingSpy.mock.calls.at(-1) as unknown as [unknown, { duration: number }];
                expect(lastCall[1].duration, kind).toBeGreaterThan(0);
                expect(lastCall[1].duration, kind).toBeLessThanOrEqual(motionTokens.durationMs.fast);
                expect(style.transform, kind).toBeUndefined();
            } finally {
                reduceMotionSpy.mockReturnValue(false);
            }
        }
    });
});
