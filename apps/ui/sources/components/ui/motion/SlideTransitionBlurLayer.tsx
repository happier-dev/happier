/**
 * Cross-platform blur overlay for `SlideTransitionFrame` layers.
 *
 * Web → CSS `filter: blur(${px}px)` driven via `useAnimatedStyle`.
 * Native → `expo-blur` `BlurView`.intensity driven via `useAnimatedProps`.
 *
 * Lazy-loads `expo-blur` only on native (web has no equivalent runtime cost).
 *
 * Per Phase 1A.0 spike conclusions: a single cross-platform implementation is
 * sufficient — the visual approximates the reference on both platforms (and on
 * Android with `experimentalBlurMethod: 'dimezisBlurView'`). If a per-platform
 * fallback is ever needed, the caller can pass `blur={false}` for that platform.
 */

import * as React from 'react';
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
    useAnimatedProps,
    useAnimatedStyle,
    type SharedValue,
} from 'react-native-reanimated';

import { resolveSlideLayerStyle, type SlideLayerRole } from './resolveSlideLayerStyle';

type AnimatedBlurViewProps = Readonly<{
    intensity?: number;
    experimentalBlurMethod?: string;
    style?: StyleProp<ViewStyle>;
    animatedProps?: object;
    testID?: string;
}>;

let cachedNativeBlurComponent: React.ComponentType<AnimatedBlurViewProps> | null = null;
let pendingNativeBlurComponent: Promise<React.ComponentType<AnimatedBlurViewProps> | null> | null = null;

function loadAnimatedNativeBlurComponent(): Promise<React.ComponentType<AnimatedBlurViewProps> | null> {
    if (Platform.OS === 'web') return Promise.resolve(null);
    if (cachedNativeBlurComponent) return Promise.resolve(cachedNativeBlurComponent);
    pendingNativeBlurComponent ??= import('expo-blur')
        .then((expoBlur) => {
            const animated = Animated.createAnimatedComponent(
                expoBlur.BlurView as React.ComponentType<AnimatedBlurViewProps>,
            );
            cachedNativeBlurComponent = animated as React.ComponentType<AnimatedBlurViewProps>;
            return cachedNativeBlurComponent;
        })
        .catch(() => null);
    return pendingNativeBlurComponent;
}

export type SlideTransitionBlurLayerProps = Readonly<{
    role: SlideLayerRole;
    progress: SharedValue<number>;
    distance: number;
    maxBlurPx: number;
    nativeBlurIntensityScale: number;
    testID?: string;
}>;

const blurOverlayStyle: ViewStyle = {
    ...StyleSheet.absoluteFillObject,
};

export function SlideTransitionBlurLayer(props: SlideTransitionBlurLayerProps): React.ReactElement | null {
    if (Platform.OS === 'web') {
        return <SlideTransitionBlurLayerWeb {...props} />;
    }
    return <SlideTransitionBlurLayerNative {...props} />;
}

/**
 * Web-only style augmentation: React Native's `ViewStyle` does not type the
 * `backdrop-filter` / `-webkit-backdrop-filter` CSS properties, but RN-web
 * passes them through to the DOM verbatim. Narrow the surface to just the
 * fields we actually set instead of escaping to `any`.
 */
type WebBackdropFilterStyle = Pick<ViewStyle, 'opacity'> & Readonly<{
    backdropFilter?: string;
    WebkitBackdropFilter?: string;
}>;

function SlideTransitionBlurLayerWeb(props: SlideTransitionBlurLayerProps): React.ReactElement {
    const animatedStyle = useAnimatedStyle(() => {
        const layer = resolveSlideLayerStyle({
            role: props.role,
            progress: props.progress.value,
            distance: props.distance,
            maxBlur: props.maxBlurPx,
        });
        // Use `backdrop-filter` (not `filter`). `filter: blur` blurs the
        // overlay's own descendants — the overlay has none, so it would do
        // nothing. `backdrop-filter` blurs the painted content BEHIND the
        // overlay in the stacking context, which is exactly the slide content
        // rendered as a sibling inside the same animated layer container.
        const blurCss = `blur(${layer.blurPx}px)`;
        const style: WebBackdropFilterStyle = {
            backdropFilter: blurCss,
            WebkitBackdropFilter: blurCss,
            opacity: layer.blurPx === 0 ? 0 : 1,
        };
        return style;
    });

    return (
        <Animated.View
            pointerEvents="none"
            style={[blurOverlayStyle, animatedStyle]}
            testID={props.testID}
        />
    );
}

function SlideTransitionBlurLayerNative(props: SlideTransitionBlurLayerProps): React.ReactElement | null {
    const [AnimatedBlurView, setAnimatedBlurView] = React.useState<React.ComponentType<AnimatedBlurViewProps> | null>(
        () => cachedNativeBlurComponent,
    );

    React.useEffect(() => {
        if (cachedNativeBlurComponent) {
            setAnimatedBlurView(() => cachedNativeBlurComponent);
            return undefined;
        }
        let active = true;
        void loadAnimatedNativeBlurComponent().then((component) => {
            if (active) setAnimatedBlurView(() => component);
        });
        return () => {
            active = false;
        };
    }, []);

    const animatedProps = useAnimatedProps(() => {
        const layer = resolveSlideLayerStyle({
            role: props.role,
            progress: props.progress.value,
            distance: props.distance,
            maxBlur: props.maxBlurPx,
        });
        const intensity = Math.min(100, Math.max(0, layer.blurPx * props.nativeBlurIntensityScale));
        return { intensity };
    });

    if (!AnimatedBlurView) return null;
    return (
        <AnimatedBlurView
            animatedProps={animatedProps as object}
            experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
            style={blurOverlayStyle}
            testID={props.testID}
        />
    );
}
