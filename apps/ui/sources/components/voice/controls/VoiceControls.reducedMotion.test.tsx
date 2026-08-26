import * as React from 'react';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';

import { TactilePressable } from './VoiceControls';

const motion = vi.hoisted(() => ({ reduced: false }));
const timingCalls = vi.hoisted(() => [] as unknown[]);
const animatedViewHostType: string = 'Animated.View';

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => motion.reduced,
}));

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const base = createReanimatedModuleMock() as Record<string, unknown>;
    return {
        ...base,
        default: (base as { default?: unknown }).default,
        withTiming: <T,>(value: T, config?: unknown): T => {
            timingCalls.push({ value, config });
            return value;
        },
    };
});

function flattenedStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>(
            (result, entry) => Object.assign(result, flattenedStyle(entry)),
            {},
        );
    }
    return style && typeof style === 'object' ? { ...style } as Record<string, unknown> : {};
}

describe('TactilePressable reduced motion', () => {
    beforeEach(() => {
        motion.reduced = false;
        timingCalls.length = 0;
    });

    function scene(): React.ReactElement {
        return (
            <VoiceEnergyProvider
                state={{ luminosity: 0.4, energized: false, direction: 'none' }}
                previewTimeMs={1_100}
            >
                <TactilePressable accessibilityLabel="Open Voice History">
                    <React.Fragment />
                </TactilePressable>
            </VoiceEnergyProvider>
        );
    }

    function pressable(screen: Awaited<ReturnType<typeof renderScreen>>): ReactTestInstance {
        const controls = screen.root.findAll((node) => (
            typeof node.type === 'string' && node.props?.accessibilityLabel === 'Open Voice History'
        ));
        expect(controls).toHaveLength(1);
        return controls[0]!;
    }

    function feedbackStyle(control: ReactTestInstance): Record<string, unknown> {
        const frames = control.findAll((node) => node.type === animatedViewHostType);
        expect(frames).toHaveLength(1);
        return flattenedStyle(frames[0]!.props.style);
    }

    it('acknowledges presses immediately without spatial motion when the canonical preference is reduced', async () => {
        motion.reduced = true;
        const screen = await renderScreen(scene());

        timingCalls.length = 0;
        await act(async () => {
            pressable(screen).props.onPressIn();
        });
        await screen.update(scene());

        expect(timingCalls).toHaveLength(0);
        expect(feedbackStyle(pressable(screen))).toEqual({ opacity: 0.7 });

        await act(async () => {
            pressable(screen).props.onPressOut();
        });
        await screen.update(scene());

        expect(timingCalls).toHaveLength(0);
        expect(feedbackStyle(pressable(screen))).toEqual({ opacity: 1 });

        await screen.unmount();
    });

    it('keeps the tactile scale response when motion is allowed', async () => {
        motion.reduced = false;
        const screen = await renderScreen(scene());

        timingCalls.length = 0;
        await act(async () => {
            pressable(screen).props.onPressIn();
        });
        await screen.update(scene());

        expect(timingCalls).toHaveLength(1);
        expect(feedbackStyle(pressable(screen))).toEqual({ transform: [{ scale: 0.96 }] });

        await screen.unmount();
    });
});
