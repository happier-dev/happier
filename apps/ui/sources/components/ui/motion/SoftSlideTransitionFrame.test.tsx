import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('SoftSlideTransitionFrame', () => {
    it('renders the first web slide without an initial blur transition', async () => {
        const { SoftSlideTransitionFrame } = await import('./SoftSlideTransitionFrame');
        const screen = await renderScreen(
            <SoftSlideTransitionFrame
                direction="replace"
                reducedMotion={false}
                testID="soft"
                transitionKey="one"
            >
                <View testID="slide-one" />
            </SoftSlideTransitionFrame>,
        );

        const currentStyle = flattenStyle(screen.findByTestId('soft-current-layer')?.props.style);

        expect(currentStyle.opacity).toBe(1);
        expect(currentStyle.filter).toBe('blur(0px)');
        expect(currentStyle.transitionProperty).toBe('opacity, transform, filter');
    });

    it('keeps outgoing and incoming web slides mounted during the blur transition', async () => {
        const { SoftSlideTransitionFrame } = await import('./SoftSlideTransitionFrame');
        const screen = await renderScreen(
            <SoftSlideTransitionFrame
                direction="replace"
                reducedMotion={false}
                testID="soft"
                transitionKey="one"
            >
                <View testID="slide-one" />
            </SoftSlideTransitionFrame>,
        );

        await screen.update(
            <SoftSlideTransitionFrame
                direction="forward"
                reducedMotion={false}
                testID="soft"
                transitionKey="two"
            >
                <View testID="slide-two" />
            </SoftSlideTransitionFrame>,
        );

        const currentStyle = flattenStyle(screen.findByTestId('soft-current-layer')?.props.style);
        const exitStyle = flattenStyle(screen.findByTestId('soft-exit-layer')?.props.style);

        expect(screen.findByTestId('slide-one')).not.toBeNull();
        expect(screen.findByTestId('slide-two')).not.toBeNull();
        expect(currentStyle.filter).toBe('blur(10px)');
        expect(exitStyle.filter).toBe('blur(0px)');
        expect(exitStyle.transitionProperty).toBe('opacity, transform, filter');
    });
});
