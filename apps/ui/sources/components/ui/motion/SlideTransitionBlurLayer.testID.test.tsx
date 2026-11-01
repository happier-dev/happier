import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { get OS() { return platform.OS; } },
    });
});

vi.mock('react-native-reanimated', async () => {
    const ReactModule = await import('react');
    type SharedValue<T> = { value: T };
    const useSharedValue = <T,>(initial: T): SharedValue<T> => {
        const ref = ReactModule.useRef<SharedValue<T> | null>(null);
        if (!ref.current) ref.current = { value: initial };
        return ref.current;
    };
    const useAnimatedStyle = <T,>(factory: () => T): T => factory();
    const useAnimatedProps = <T,>(factory: () => T): T => factory();
    const Animated = {
        View: 'Animated.View',
        ScrollView: 'Animated.ScrollView',
        Text: 'Animated.Text',
        createAnimatedComponent: (component: unknown) => component,
    };
    return {
        __esModule: true,
        default: Animated,
        ...Animated,
        useAnimatedProps,
        useAnimatedStyle,
        useSharedValue,
    };
});

vi.mock('expo-blur', () => ({
    BlurView: 'BlurView',
}));

afterEach(() => {
    platform.OS = 'ios';
});

async function renderBlurLayer() {
    const Reanimated = await import('react-native-reanimated');
    const { SlideTransitionBlurLayer } = await import('./SlideTransitionBlurLayer');

    function Harness(): React.ReactElement {
        const progress = Reanimated.useSharedValue(0);
        return (
            <SlideTransitionBlurLayer
                role="current"
                progress={progress}
                distance={32}
                maxBlurPx={12}
                nativeBlurIntensityScale={3}
                testID="my-blur"
            />
        );
    }

    const screen = await renderScreen(<Harness />);
    // Await the actual lazy import, then let React commit its state update.
    await act(async () => {
        await vi.dynamicImportSettled();
    });
    return screen;
}

describe('SlideTransitionBlurLayer (native)', () => {
    it('forwards testID to the native AnimatedBlurView so visual QA harnesses can target the rendered blur element', async () => {
        const screen = await renderBlurLayer();

        // The native blur path renders an `AnimatedBlurView` (a host component named
        // 'BlurView' under the test mock). The testID prop must be forwarded onto it
        // so visual QA harnesses and tests can target the rendered blur element.
        const blurNode = screen.findByType('BlurView');
        expect(blurNode.props.testID).toBe('my-blur');
    });

    // expo-blur's Android (Dimezis) blur redraws the whole app per frame and leaks its pre-draw
    // hooks after unmount, so Android slides without the blur overlay.
    it('mounts no blur view on Android', async () => {
        platform.OS = 'android';

        const screen = await renderBlurLayer();

        expect(screen.findAllByType('BlurView')).toHaveLength(0);
    });
});
