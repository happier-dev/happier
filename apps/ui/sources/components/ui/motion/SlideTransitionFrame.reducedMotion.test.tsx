import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('SlideTransitionFrame reducedMotion', () => {
    it('does NOT mount any blur layer when reducedMotion=true and blur=true', async () => {
        const Reanimated = await import('react-native-reanimated');
        const { SlideTransitionFrame } = await import('./SlideTransitionFrame');

        function Harness(): React.ReactElement {
            const progress = Reanimated.useSharedValue(0);
            return (
                <SlideTransitionFrame
                    current={<View testID="current" />}
                    next={<View testID="next" />}
                    previous={<View testID="previous" />}
                    progress={progress}
                    blur
                    reducedMotion
                    testID="frame"
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        // All three layers still render — reduced motion doesn't strip layers, only blur.
        expect(screen.findByTestId('frame-current-layer')).not.toBeNull();
        expect(screen.findByTestId('frame-next-layer')).not.toBeNull();
        expect(screen.findByTestId('frame-previous-layer')).not.toBeNull();
        // No blur layer for any of them.
        expect(screen.findByTestId('frame-current-blur')).toBeNull();
        expect(screen.findByTestId('frame-next-blur')).toBeNull();
        expect(screen.findByTestId('frame-previous-blur')).toBeNull();
    });

    it('still mounts the blur layer when reducedMotion=false and blur=true', async () => {
        const Reanimated = await import('react-native-reanimated');
        const { SlideTransitionFrame } = await import('./SlideTransitionFrame');

        function Harness(): React.ReactElement {
            const progress = Reanimated.useSharedValue(0);
            return (
                <SlideTransitionFrame
                    current={<View testID="current" />}
                    progress={progress}
                    blur
                    reducedMotion={false}
                    testID="frame"
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        expect(screen.findByTestId('frame-current-blur')).not.toBeNull();
    });
});
