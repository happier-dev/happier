import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

/**
 * React Native's native animation driver only animates transform and opacity; a native-driven
 * animation bound to a layout property such as `width` throws on device. The boundary
 * settles timing at its target; readFill separately checks the bound properties and visible value.
 */

const boundary = vi.hoisted(() => ({
    reducedMotionListener: null as ((enabled: boolean) => void) | null,
    timings: [] as Array<{ toValue: number; useNativeDriver: boolean }>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' }, {
        View: 'View',
        Animated: {
            timing: (value: { setValue: (next: number) => void }, config: { toValue: number; useNativeDriver: boolean }) => ({
                start: (callback?: (result: { finished: boolean }) => void) => {
                    boundary.timings.push({ toValue: config.toValue, useNativeDriver: config.useNativeDriver });
                    value.setValue(config.toValue);
                    callback?.({ finished: true });
                },
                stop: () => {},
            }),
        },
        AccessibilityInfo: {
            isReduceMotionEnabled: async () => false,
            addEventListener: (_event: string, listener: (enabled: boolean) => void) => {
                boundary.reducedMotionListener = listener;
                return { remove: () => { boundary.reducedMotionListener = null; } };
            },
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

type AnimatedNode = { __getValue: () => number };

function isAnimatedNode(value: unknown): value is AnimatedNode {
    return Boolean(value) && typeof (value as AnimatedNode).__getValue === 'function';
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) return style.reduce((acc, item) => Object.assign(acc, flattenStyle(item)), {} as Record<string, unknown>);
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function readFill(screen: Screen) {
    const fill = screen.findHostByTestId('bar:fill');
    const style = flattenStyle(fill!.props.style);
    const animatedLayoutKeys = Object.entries(style)
        .filter(([key, value]) => key !== 'transform' && key !== 'opacity' && isAnimatedNode(value))
        .map(([key]) => key);
    const transform = Array.isArray(style.transform) ? (style.transform as Array<Record<string, unknown>>) : [];
    const scale = transform.map((entry) => entry.scaleX).find(isAnimatedNode);
    return { animatedLayoutKeys, fraction: scale?.__getValue() ?? null };
}

const mounted: Screen[] = [];

async function renderBar(progress: number) {
    const { MeterBar } = await import('./MeterBar');
    const screen = await renderScreen(<MeterBar testID="bar" tone="neutral" animated fillFraction={progress} progressAccessibilityLabel="Download progress" />);
    mounted.push(screen);
    return { screen, MeterBar };
}

afterEach(async () => {
    for (const screen of mounted.splice(0)) await screen.unmount();
    act(() => boundary.reducedMotionListener?.(false));
    boundary.timings.length = 0;
});

describe('MeterBar (native)', () => {
    it('exposes its value to assistive technology', async () => {
        const { screen } = await renderBar(0.456);
        const bar = screen.findHostByTestId('bar')!;
        expect(bar.props.accessibilityRole).toBe('progressbar');
        expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 46 });
    });

    it('animates the fill only through properties the native driver supports', async () => {
        const { screen, MeterBar } = await renderBar(0.2);
        await screen.update(<MeterBar testID="bar" tone="neutral" animated fillFraction={0.7} progressAccessibilityLabel="Download progress" />);

        expect(boundary.timings.at(-1)).toEqual({ toValue: 0.7, useNativeDriver: true });
        expect(readFill(screen)).toEqual({ animatedLayoutKeys: [], fraction: 0.7 });
    });

    it('moves the fill without animating when the user prefers reduced motion', async () => {
        const { screen, MeterBar } = await renderBar(0.2);
        act(() => boundary.reducedMotionListener?.(true));
        boundary.timings.length = 0;

        await screen.update(<MeterBar testID="bar" tone="neutral" animated fillFraction={0.8} progressAccessibilityLabel="Download progress" />);

        expect(boundary.timings).toEqual([]);
        expect(readFill(screen).fraction).toBe(0.8);
    });
});
