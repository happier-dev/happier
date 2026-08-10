import * as React from 'react';
import { Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ICON_CIRCLE_INK_RATIO } from '@/components/ui/feedback/ActivitySpinner';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const reducedMotionState = vi.hoisted(() => ({ enabled: false }));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionState.enabled,
}));

const animationCalls = vi.hoisted(() => ({
    spring: [] as Array<{ toValue: unknown; config: Record<string, unknown> | undefined }>,
    timing: [] as Array<{ toValue: unknown; config: Record<string, unknown> | undefined }>,
    delay: [] as number[],
}));

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const mock = createReanimatedModuleMock();
    return {
        ...mock,
        withSpring: <T,>(toValue: T, config?: Record<string, unknown>): T => {
            animationCalls.spring.push({ toValue, config });
            return toValue;
        },
        withTiming: <T,>(toValue: T, config?: Record<string, unknown>): T => {
            animationCalls.timing.push({ toValue, config });
            return toValue;
        },
        withDelay: <T,>(delayMs: number, animation: T): T => {
            animationCalls.delay.push(delayMs);
            return animation;
        },
    };
});

const BOX_PX = 20;
// Not 0.8 written out: the incoming glyph starts at the UNCORRECTED ink size and grows into the
// corrected one, so the growth is the size correction becoming true. Importing the ratio is what
// keeps that derivation real instead of a coincidence between two literals.
const FROM_SCALE = ICON_CIRCLE_INK_RATIO;

function renderMark(key: string): React.ReactElement {
    return <Text testID={`mark-${key}`}>{key}</Text>;
}

async function renderTransition(statusKey: string) {
    const { StatusTransition } = await import('./StatusTransition');
    const element = (
        <StatusTransition transitionKey={statusKey} size={BOX_PX} fromScale={FROM_SCALE} testID="settle">
            {renderMark(statusKey)}
        </StatusTransition>
    );
    const screen = await renderScreen(element);
    return {
        screen,
        async swapTo(nextKey: string): Promise<void> {
            const { StatusTransition: Component } = await import('./StatusTransition');
            await act(async () => {
                screen.tree.update(
                    <Component transitionKey={nextKey} size={BOX_PX} fromScale={FROM_SCALE} testID="settle">
                        {renderMark(nextKey)}
                    </Component>,
                );
            });
        },
    };
}

beforeEach(() => {
    reducedMotionState.enabled = false;
    animationCalls.spring.length = 0;
    animationCalls.timing.length = 0;
    animationCalls.delay.length = 0;
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('StatusTransition timeline', () => {
    it('is derived from the statusSettle spring, not restated', async () => {
        const { STATUS_TRANSITION_TIMELINE } = await import('./StatusTransition');
        const { describeMotionSpring } = await import('./motionSprings');

        expect(STATUS_TRANSITION_TIMELINE.exitFadeMs).toBe(110);
        expect(STATUS_TRANSITION_TIMELINE.enterDelayMs).toBe(40);
        expect(STATUS_TRANSITION_TIMELINE.enterFadeMs).toBe(130);
        expect(STATUS_TRANSITION_TIMELINE.totalMs).toBe(
            STATUS_TRANSITION_TIMELINE.enterDelayMs + Math.round(describeMotionSpring('statusSettle').settleMs),
        );
        expect(STATUS_TRANSITION_TIMELINE.totalMs).toBe(261);
    });
});

describe('StatusTransition', () => {
    it('mounts a single layer before anything changes', async () => {
        const { screen } = await renderTransition('running');

        expect(screen.findByTestId('mark-running')).not.toBeNull();
        expect(screen.findByTestId('settle-outgoing')).toBeNull();
        expect(screen.findByTestId('settle-incoming')).not.toBeNull();
    });

    it('cross-fades two layers rather than morphing one', async () => {
        const { screen, swapTo } = await renderTransition('running');
        await swapTo('succeeded');

        // Both marks on screen at once is the whole contract: a morph would show one node whose
        // glyph changed, and the outgoing spinner would disappear on the same frame.
        expect(screen.findByTestId('mark-running')).not.toBeNull();
        expect(screen.findByTestId('mark-succeeded')).not.toBeNull();
        expect(screen.findByTestId('settle-outgoing')).not.toBeNull();
    });

    it('runs the specified curves: 110ms exit, 40ms-delayed 130ms enter, statusSettle scale', async () => {
        const { swapTo } = await renderTransition('running');
        const { resolveMotionSpring } = await import('./motionSprings');
        await swapTo('failed');

        expect(animationCalls.timing.map((call) => call.config?.duration)).toEqual([110, 130]);
        expect(animationCalls.timing.map((call) => call.toValue)).toEqual([0, 1]);
        expect(animationCalls.delay).toEqual([40, 40]);
        expect(animationCalls.spring).toHaveLength(1);
        expect(animationCalls.spring[0]?.toValue).toBe(1);
        expect(animationCalls.spring[0]?.config).toEqual(
            resolveMotionSpring('statusSettle', { reducedMotion: false }),
        );
    });

    it('retires the outgoing layer when the settle ends, not before', async () => {
        const { screen, swapTo } = await renderTransition('running');
        const { STATUS_TRANSITION_TIMELINE } = await import('./StatusTransition');
        await swapTo('succeeded');

        await act(async () => {
            vi.advanceTimersByTime(STATUS_TRANSITION_TIMELINE.totalMs - 1);
        });
        expect(screen.findByTestId('settle-outgoing')).not.toBeNull();

        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(screen.findByTestId('settle-outgoing')).toBeNull();
        expect(screen.findByTestId('mark-running')).toBeNull();
        expect(screen.findByTestId('mark-succeeded')).not.toBeNull();
    });

    it('keeps the retiring mark out of the accessibility tree while it fades', async () => {
        const { screen, swapTo } = await renderTransition('running');
        await swapTo('succeeded');

        // For 261ms both marks are mounted. Only one of them is true, so a screen reader must
        // never be able to reach the other — otherwise a settling row announces its old status
        // and its new one in the same breath.
        const outgoing = screen.findByTestId('settle-outgoing');
        expect(outgoing?.props['aria-hidden']).toBe(true);
        expect(outgoing?.props.accessibilityElementsHidden).toBe(true);
        expect(outgoing?.props.importantForAccessibility).toBe('no-hide-descendants');

        const incoming = screen.findByTestId('settle-incoming');
        expect(incoming?.props['aria-hidden']).toBeUndefined();
        expect(incoming?.props.accessibilityElementsHidden).toBeUndefined();
    });

    it('never lets the box change size, and never animates anything but opacity and scale', async () => {
        const { screen, swapTo } = await renderTransition('running');
        await swapTo('succeeded');

        // Host queries, not composite ones: the assertion is about the box that actually painted,
        // and a composite would hand back its unresolved `style` prop instead.
        const boxStyle = flattenStyle(screen.findHostByTestId('settle')?.props.style);
        expect(boxStyle.width).toBe(BOX_PX);
        expect(boxStyle.height).toBe(BOX_PX);

        for (const layerId of ['settle-outgoing', 'settle-incoming']) {
            const layerStyle = flattenStyle(screen.findHostByTestId(layerId)?.props.style);
            // Absolutely positioned: the two layers stack, so neither one's presence can move the
            // other, or anything beside the box.
            expect(layerStyle.position).toBe('absolute');
            expect(layerStyle.backgroundColor).toBeUndefined();
            expect(layerStyle.width).toBeUndefined();
        }
    });

    it('swaps immediately under reduced motion, with no timer and no spring', async () => {
        reducedMotionState.enabled = true;
        const { screen, swapTo } = await renderTransition('running');
        await swapTo('succeeded');

        expect(screen.findByTestId('mark-succeeded')).not.toBeNull();
        expect(screen.findByTestId('mark-running')).toBeNull();
        expect(screen.findByTestId('settle-outgoing')).toBeNull();
        expect(animationCalls.spring).toHaveLength(0);
        expect(animationCalls.timing).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('honours an explicit reducedMotion prop over the preference store', async () => {
        const { StatusTransition } = await import('./StatusTransition');
        const screen = await renderScreen(
            <StatusTransition transitionKey="running" size={BOX_PX} fromScale={FROM_SCALE} reducedMotion testID="settle">
                {renderMark('running')}
            </StatusTransition>,
        );

        await act(async () => {
            screen.tree.update(
                <StatusTransition transitionKey="succeeded" size={BOX_PX} fromScale={FROM_SCALE} reducedMotion testID="settle">
                    {renderMark('succeeded')}
                </StatusTransition>,
            );
        });

        expect(screen.findByTestId('settle-outgoing')).toBeNull();
        expect(animationCalls.spring).toHaveLength(0);
    });

    it('restarts cleanly when a second change lands mid-settle', async () => {
        const { screen, swapTo } = await renderTransition('running');
        const { STATUS_TRANSITION_TIMELINE } = await import('./StatusTransition');
        await swapTo('succeeded');
        await act(async () => {
            vi.advanceTimersByTime(100);
        });
        await swapTo('failed');

        expect(screen.findByTestId('mark-succeeded')).not.toBeNull();
        expect(screen.findByTestId('mark-failed')).not.toBeNull();
        expect(screen.findByTestId('mark-running')).toBeNull();

        // The first transition's retirement timer must not cut the second one short.
        await act(async () => {
            vi.advanceTimersByTime(STATUS_TRANSITION_TIMELINE.totalMs - 1);
        });
        expect(screen.findByTestId('settle-outgoing')).not.toBeNull();
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(screen.findByTestId('settle-outgoing')).toBeNull();
    });

    it('leaves no timer behind when it unmounts mid-settle', async () => {
        const { screen, swapTo } = await renderTransition('running');
        await swapTo('succeeded');
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        await act(async () => {
            screen.tree.update(<View testID="gone" />);
        });

        expect(vi.getTimerCount()).toBe(0);
    });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>(
            (accumulator, entry) => ({ ...accumulator, ...flattenStyle(entry) }),
            {},
        );
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}
