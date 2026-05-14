/**
 * Low-level multi-layer renderer for the unified slide transition primitives.
 *
 * Stateless. Caller drives `progress: SharedValue<number>` in -1..1; adapters
 * (`SlideTransitionSwitch`, `StoryDeckSlideTransition`) own that signal and pass it
 * down. Renders up to three layers:
 *   - `current` (always)
 *   - `previous?` (when supplied)
 *   - `next?` (when supplied)
 *
 * Each layer is wrapped in an `Animated.View` whose style is computed via
 * `useAnimatedStyle` calling the worklet-safe `resolveSlideLayerStyle`. Optionally
 * overlaid with a per-layer `SlideTransitionBlurLayer` (web → CSS filter; native →
 * BlurView via animated intensity) when `blur === true`.
 *
 * Reduced motion: blur layer is not mounted at all (zero cost).
 */

import * as React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { resolveSlideLayerStyle, type SlideLayerRole } from './resolveSlideLayerStyle';
import { SlideTransitionBlurLayer } from './SlideTransitionBlurLayer';
import { slideTransitionTokens } from './slideTransitionTokens';
import type { SlideTransitionFrameProps } from './_types';

const stylesheet = StyleSheet.create({
    container: {
        flex: 1,
        minHeight: 0,
        position: 'relative',
        overflow: 'hidden',
    },
    layer: {
        flex: 1,
        minHeight: 0,
    },
    overlayLayer: {
        ...StyleSheet.absoluteFillObject,
    },
});

export function SlideTransitionFrame(props: SlideTransitionFrameProps): React.ReactElement {
    const preset = props.preset ?? 'soft';
    const presetTokens = slideTransitionTokens[preset];
    const distance = presetTokens.translatePx;
    const blurEnabled = props.blur !== false && !props.reducedMotion;
    const maxBlur = blurEnabled ? presetTokens.maxBlurPx : 0;

    return (
        <View style={[stylesheet.container, props.style]} testID={props.testID}>
            {props.previous != null ? (
                <SlideTransitionLayer
                    role="previous"
                    progress={props.progress}
                    distance={distance}
                    maxBlurPx={maxBlur}
                    nativeBlurIntensityScale={presetTokens.nativeBlurIntensityScale}
                    overlay
                    testID={props.testID ? `${props.testID}-previous-layer` : undefined}
                    blurTestID={props.testID ? `${props.testID}-previous-blur` : undefined}
                    blurEnabled={blurEnabled}
                >
                    {props.previous}
                </SlideTransitionLayer>
            ) : null}
            <SlideTransitionLayer
                role="current"
                progress={props.progress}
                distance={distance}
                maxBlurPx={maxBlur}
                nativeBlurIntensityScale={presetTokens.nativeBlurIntensityScale}
                overlay={false}
                testID={props.testID ? `${props.testID}-current-layer` : undefined}
                blurTestID={props.testID ? `${props.testID}-current-blur` : undefined}
                blurEnabled={blurEnabled}
            >
                {props.current}
            </SlideTransitionLayer>
            {props.next != null ? (
                <SlideTransitionLayer
                    role="next"
                    progress={props.progress}
                    distance={distance}
                    maxBlurPx={maxBlur}
                    nativeBlurIntensityScale={presetTokens.nativeBlurIntensityScale}
                    overlay
                    testID={props.testID ? `${props.testID}-next-layer` : undefined}
                    blurTestID={props.testID ? `${props.testID}-next-blur` : undefined}
                    blurEnabled={blurEnabled}
                >
                    {props.next}
                </SlideTransitionLayer>
            ) : null}
        </View>
    );
}

type SlideTransitionLayerProps = Readonly<{
    role: SlideLayerRole;
    progress: SharedValue<number>;
    distance: number;
    maxBlurPx: number;
    nativeBlurIntensityScale: number;
    children: React.ReactNode;
    overlay: boolean;
    blurEnabled: boolean;
    testID?: string;
    blurTestID?: string;
}>;

function SlideTransitionLayer(props: SlideTransitionLayerProps): React.ReactElement {
    const layerStyle = useAnimatedStyle(() => {
        const style = resolveSlideLayerStyle({
            role: props.role,
            progress: props.progress.value,
            distance: props.distance,
            maxBlur: props.maxBlurPx,
        });
        return {
            transform: [{ translateX: style.translateX }],
            opacity: style.opacity,
        };
    });

    const containerStyle: StyleProp<ViewStyle> = props.overlay
        ? [stylesheet.overlayLayer]
        : [stylesheet.layer];

    return (
        <Animated.View
            pointerEvents={props.overlay ? 'none' : 'auto'}
            style={[containerStyle, layerStyle]}
            testID={props.testID}
        >
            {props.children}
            {props.blurEnabled ? (
                <SlideTransitionBlurLayer
                    role={props.role}
                    progress={props.progress}
                    distance={props.distance}
                    maxBlurPx={props.maxBlurPx}
                    nativeBlurIntensityScale={props.nativeBlurIntensityScale}
                    testID={props.blurTestID}
                />
            ) : null}
        </Animated.View>
    );
}
