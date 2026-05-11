import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: <T,>(options: { ios?: T; native?: T; default?: T; web?: T; android?: T }) =>
                options.ios ?? options.native ?? options.default ?? options.web ?? options.android,
        },
    });
});

vi.mock('expo-blur', () => ({
    BlurView: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, props.children),
}));

describe('SoftSlideTransitionFrame native blur', () => {
    it('renders native blur overlays while slides transition', async () => {
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

        expect(screen.findAllByType('BlurView')).toHaveLength(2);
    });
});
