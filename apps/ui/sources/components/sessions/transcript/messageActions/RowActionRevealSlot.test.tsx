import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MediaChangeListener = (event: { matches: boolean }) => void;

const platformState = vi.hoisted(() => ({ os: 'web' }));
const animatedState = vi.hoisted(() => ({ timingCalls: 0 }));
const hostState = vi.hoisted(() => ({
    reduceMotion: false,
    changeListeners: [] as MediaChangeListener[],
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

function readOpacity(style: unknown): number | undefined {
    const opacity = flattenStyle(style).opacity;
    if (typeof opacity === 'number') return opacity;
    const animated = opacity as { __getValue?: () => number } | undefined;
    return typeof animated?.__getValue === 'function' ? animated.__getValue() : undefined;
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const runtime = await createReactNativeWebMock({
        Platform: {
            get OS() {
                return platformState.os;
            },
            select: (values: Record<string, unknown>) => values[platformState.os] ?? values.default,
        },
    });
    const timing = runtime.Animated.timing;
    return {
        ...runtime,
        Animated: {
            ...runtime.Animated,
            timing: (value: unknown, config: unknown) => {
                animatedState.timingCalls += 1;
                return timing(value, config);
            },
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function installHostMediaQuery(): () => void {
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
        matchMedia: (query: string) => ({
            matches: query === '(prefers-reduced-motion: reduce)' ? hostState.reduceMotion : false,
            addEventListener: (event: string, listener: MediaChangeListener) => {
                if (event === 'change') hostState.changeListeners.push(listener);
            },
            removeEventListener: (event: string, listener: MediaChangeListener) => {
                if (event !== 'change') return;
                const index = hostState.changeListeners.indexOf(listener);
                if (index >= 0) hostState.changeListeners.splice(index, 1);
            },
        }),
    };
    return () => {
        (globalThis as { window?: unknown }).window = previousWindow;
    };
}

function publishHostPreference(reduceMotion: boolean): void {
    hostState.reduceMotion = reduceMotion;
    for (const listener of [...hostState.changeListeners]) {
        listener({ matches: reduceMotion });
    }
}

describe('RowActionRevealSlot', () => {
    let restoreWindow: () => void = () => undefined;

    beforeEach(() => {
        restoreWindow = installHostMediaQuery();
    });

    afterEach(() => {
        standardCleanup();
        restoreWindow();
        vi.resetModules();
        platformState.os = 'web';
        animatedState.timingCalls = 0;
        hostState.reduceMotion = false;
        hostState.changeListeners.length = 0;
    });

    it('reserves its footprint and blocks pointer interaction while hidden', async () => {
        const { RowActionRevealSlot } = await import('./RowActionRevealSlot');

        const screen = await renderScreen(
            <RowActionRevealSlot revealed={false} reserveWidth={26} testID="slot">
                <Pressable testID="slot-action" onPress={() => undefined} />
            </RowActionRevealSlot>,
        );

        const style = flattenStyle(screen.findByTestId('slot')?.props.style);
        expect(style.width).toBe(26);
        expect(style.pointerEvents).toBe('none');
        expect(readOpacity(style)).toBe(0);
        expect(screen.findByTestId('slot-action')).toBeTruthy();
    });

    it('reveals on descendant focus so a hidden action is never activatable while invisible', async () => {
        const { RowActionRevealSlot } = await import('./RowActionRevealSlot');

        const screen = await renderScreen(
            <RowActionRevealSlot revealed={false} testID="slot">
                <Pressable testID="slot-action" onPress={() => undefined} />
            </RowActionRevealSlot>,
        );

        expect(readOpacity(screen.findByTestId('slot')?.props.style)).toBe(0);
        // Hidden actions stay in the accessibility tree: hiding them from assistive
        // tech while leaving them focusable is what made invisible buttons activatable.
        expect(screen.findByTestId('slot')?.props.accessibilityElementsHidden).toBeUndefined();
        expect(screen.findByTestId('slot')?.props.importantForAccessibility).toBeUndefined();

        act(() => {
            screen.findByTestId('slot')?.props.onFocus?.();
        });

        expect(readOpacity(screen.findByTestId('slot')?.props.style)).toBe(1);
        expect(flattenStyle(screen.findByTestId('slot')?.props.style).pointerEvents).toBe('auto');

        act(() => {
            screen.findByTestId('slot')?.props.onBlur?.();
        });

        expect(readOpacity(screen.findByTestId('slot')?.props.style)).toBe(0);
    });

    it('notifies the host when descendant focus enters and leaves', async () => {
        const { RowActionRevealSlot } = await import('./RowActionRevealSlot');
        const onFocus = vi.fn();
        const onBlur = vi.fn();

        const screen = await renderScreen(
            <RowActionRevealSlot revealed={false} testID="slot" onFocus={onFocus} onBlur={onBlur}>
                <Pressable testID="slot-action" onPress={() => undefined} />
            </RowActionRevealSlot>,
        );

        act(() => {
            screen.findByTestId('slot')?.props.onFocus?.();
        });
        act(() => {
            screen.findByTestId('slot')?.props.onBlur?.();
        });

        expect(onFocus).toHaveBeenCalledTimes(1);
        expect(onBlur).toHaveBeenCalledTimes(1);
    });

    it('costs no host listener and no animation per mounted slot', async () => {
        const { RowActionRevealSlot } = await import('./RowActionRevealSlot');

        // A virtualized transcript mounts and unmounts these by the hundred while
        // scrolling, so mount cost is the contract: reduce-motion is a host property
        // watched once for the app, and a slot that lands on its resting opacity has
        // nothing to animate.
        const screen = await renderScreen(
            <>
                {Array.from({ length: 8 }, (_, index) => (
                    <RowActionRevealSlot key={index} revealed={index === 0} testID={`slot-${index}`}>
                        <Pressable testID={`slot-action-${index}`} onPress={() => undefined} />
                    </RowActionRevealSlot>
                ))}
            </>,
        );

        expect(animatedState.timingCalls).toBe(0);
        expect(hostState.changeListeners.length).toBeLessThanOrEqual(1);
        // Skipping the mount animation must still leave each slot on its resting state.
        expect(readOpacity(screen.findByTestId('slot-0')?.props.style)).toBe(1);
        expect(readOpacity(screen.findByTestId('slot-7')?.props.style)).toBe(0);
    });

    it('honors a host reduce-motion preference that flips after the slot mounted', async () => {
        const { RowActionRevealSlot } = await import('./RowActionRevealSlot');

        const screen = await renderScreen(
            <RowActionRevealSlot revealed={false} testID="slot">
                <Pressable testID="slot-action" onPress={() => undefined} />
            </RowActionRevealSlot>,
        );

        act(() => {
            publishHostPreference(true);
        });
        // Mount cost is asserted by its own test; this one is about the reveal.
        animatedState.timingCalls = 0;

        act(() => {
            screen.findByTestId('slot')?.props.onFocus?.();
        });

        expect(animatedState.timingCalls).toBe(0);
        expect(readOpacity(screen.findByTestId('slot')?.props.style)).toBe(1);
    });

    it('uses the native pointerEvents prop off web', async () => {
        platformState.os = 'ios';
        const { RowActionRevealSlot } = await import('./RowActionRevealSlot');

        const screen = await renderScreen(
            <RowActionRevealSlot revealed={false} testID="slot">
                <Pressable testID="slot-action" onPress={() => undefined} />
            </RowActionRevealSlot>,
        );

        expect(screen.findByTestId('slot')?.props.pointerEvents).toBe('none');
    });
});
