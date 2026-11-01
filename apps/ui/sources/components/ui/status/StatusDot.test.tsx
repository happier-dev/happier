import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

const motionPreference = {
    matches: false,
    listeners: new Set<(event: { matches: boolean }) => void>(),
    addEventListener(_event: string, listener: (event: { matches: boolean }) => void) {
        this.listeners.add(listener);
    },
};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Platform: {
            OS: 'web',
            select: (value: any) => value?.web ?? value?.default,
        },
    });
});

vi.mock('react-native-reanimated', () => ({
    default: { View: 'AnimatedView' },
    useAnimatedStyle: () => ({ opacity: 1 }),
    useSharedValue: (value: number) => ({ value }),
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown) => value,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, item) => Object.assign(acc, flattenStyle(item)), {} as Record<string, unknown>);
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('StatusDot', () => {
    beforeEach(async () => {
        vi.stubGlobal('window', { matchMedia: () => motionPreference });
        vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
        await React.act(async () => {
            motionPreference.matches = false;
            for (const listener of motionPreference.listeners) listener({ matches: false });
        });
    });

    afterEach(() => {
        standardCleanup();
        vi.unstubAllGlobals();
    });

    it('pauses a retained dot while hidden or reduced motion is requested and resumes when allowed', async () => {
        const { StatusDot } = await import('./StatusDot');
        const screen = await renderScreen(React.createElement(StatusDot, {
            color: 'orange', isPulsing: true, testID: 'status-dot',
        }));
        const host = screen.findHostByTestId('status-dot');
        const isAnimating = () => Boolean(flattenStyle(screen.findHostByTestId('status-dot')?.props.style).animationName);
        expect(isAnimating()).toBe(true);

        await React.act(async () => {
            Object.assign(document, { visibilityState: 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(screen.findHostByTestId('status-dot')).toBe(host);
        expect(isAnimating()).toBe(false);

        await React.act(async () => {
            Object.assign(document, { visibilityState: 'visible' });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(isAnimating()).toBe(true);

        await React.act(async () => {
            motionPreference.matches = true;
            for (const listener of motionPreference.listeners) listener({ matches: true });
        });
        expect(screen.findHostByTestId('status-dot')).toBe(host);
        expect(isAnimating()).toBe(false);

        await React.act(async () => {
            motionPreference.matches = false;
            for (const listener of motionPreference.listeners) listener({ matches: false });
        });
        expect(isAnimating()).toBe(true);
    });

    it('uses a CSS pulse on web instead of a Reanimated view', async () => {
        const { StatusDot } = await import('./StatusDot');
        const screen = await renderScreen(React.createElement(StatusDot, {
            color: 'red',
            isPulsing: true,
            size: 10,
        }));

        const dot = screen.findByType('View');
        expect(dot).toBeTruthy();
        expect(dot?.type).toBe('View');
        const style = flattenStyle(dot?.props.style);
        expect(style.animationName).toBe('happierStatusDotPulse');
        expect(style.animationTimingFunction).toBe('steps(6, end)');
    });

    it('can show a pulsing-state web dot without scheduling a CSS pulse animation', async () => {
        const { StatusDot } = await import('./StatusDot');
        const screen = await renderScreen(React.createElement(StatusDot, {
            color: 'red',
            isPulsing: true,
            animationEnabled: false,
            size: 10,
        }));

        const dot = screen.findByType('View');
        const style = flattenStyle(dot?.props.style);
        expect(style.animationName).toBeUndefined();
        expect(style.animationIterationCount).toBeUndefined();
        expect(style.backgroundColor).toBe('red');
    });
});
