import * as React from 'react';
import { Text, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('SlideTransitionFrame (low-level renderer)', () => {
    it('renders only the current layer when previous and next are absent', async () => {
        const Reanimated = await import('react-native-reanimated');
        const { SlideTransitionFrame } = await import('./SlideTransitionFrame');

        function Harness(): React.ReactElement {
            const progress = Reanimated.useSharedValue(0);
            return (
                <SlideTransitionFrame
                    current={<View testID="current" />}
                    progress={progress}
                    blur={false}
                    testID="frame"
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        expect(screen.findByTestId('frame-current-layer')).not.toBeNull();
        expect(screen.findByTestId('frame-previous-layer')).toBeNull();
        expect(screen.findByTestId('frame-next-layer')).toBeNull();
        expect(screen.findByTestId('current')).not.toBeNull();
    });

    it('mounts the next layer when supplied', async () => {
        const Reanimated = await import('react-native-reanimated');
        const { SlideTransitionFrame } = await import('./SlideTransitionFrame');

        function Harness(): React.ReactElement {
            const progress = Reanimated.useSharedValue(0);
            return (
                <SlideTransitionFrame
                    current={<View testID="current" />}
                    next={<View testID="next" />}
                    progress={progress}
                    blur={false}
                    testID="frame"
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        expect(screen.findByTestId('frame-current-layer')).not.toBeNull();
        expect(screen.findByTestId('frame-next-layer')).not.toBeNull();
        expect(screen.findByTestId('frame-previous-layer')).toBeNull();
    });

    it('mounts the previous layer when supplied', async () => {
        const Reanimated = await import('react-native-reanimated');
        const { SlideTransitionFrame } = await import('./SlideTransitionFrame');

        function Harness(): React.ReactElement {
            const progress = Reanimated.useSharedValue(0);
            return (
                <SlideTransitionFrame
                    current={<View testID="current" />}
                    previous={<View testID="previous" />}
                    progress={progress}
                    blur={false}
                    testID="frame"
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        expect(screen.findByTestId('frame-current-layer')).not.toBeNull();
        expect(screen.findByTestId('frame-previous-layer')).not.toBeNull();
        expect(screen.findByTestId('frame-next-layer')).toBeNull();
    });

    it('mounts all three layers when supplied (carousel mode)', async () => {
        const Reanimated = await import('react-native-reanimated');
        const { SlideTransitionFrame } = await import('./SlideTransitionFrame');

        function Harness(): React.ReactElement {
            const progress = Reanimated.useSharedValue(0);
            return (
                <SlideTransitionFrame
                    current={<Text testID="cur">curr</Text>}
                    previous={<Text testID="prv">prev</Text>}
                    next={<Text testID="nxt">next</Text>}
                    progress={progress}
                    blur={false}
                    testID="frame"
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        expect(screen.findByTestId('frame-current-layer')).not.toBeNull();
        expect(screen.findByTestId('frame-previous-layer')).not.toBeNull();
        expect(screen.findByTestId('frame-next-layer')).not.toBeNull();
        expect(screen.findByTestId('cur')).not.toBeNull();
        expect(screen.findByTestId('prv')).not.toBeNull();
        expect(screen.findByTestId('nxt')).not.toBeNull();
    });

    it('mounts a blur layer per slot when blur=true', async () => {
        const Reanimated = await import('react-native-reanimated');
        const { SlideTransitionFrame } = await import('./SlideTransitionFrame');

        function Harness(): React.ReactElement {
            const progress = Reanimated.useSharedValue(0);
            return (
                <SlideTransitionFrame
                    current={<View testID="current" />}
                    next={<View testID="next" />}
                    progress={progress}
                    blur
                    testID="frame"
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        expect(screen.findByTestId('frame-current-blur')).not.toBeNull();
        expect(screen.findByTestId('frame-next-blur')).not.toBeNull();
    });

    it('does NOT mount a blur layer when blur=false', async () => {
        const Reanimated = await import('react-native-reanimated');
        const { SlideTransitionFrame } = await import('./SlideTransitionFrame');

        function Harness(): React.ReactElement {
            const progress = Reanimated.useSharedValue(0);
            return (
                <SlideTransitionFrame
                    current={<View testID="current" />}
                    next={<View testID="next" />}
                    progress={progress}
                    blur={false}
                    testID="frame"
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        expect(screen.findByTestId('frame-current-blur')).toBeNull();
        expect(screen.findByTestId('frame-next-blur')).toBeNull();
    });
});
