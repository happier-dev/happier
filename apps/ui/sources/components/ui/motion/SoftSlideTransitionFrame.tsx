import * as React from 'react';
import { Animated, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { getBlurViewComponent } from '@/components/ui/glass/blurMaterial';

import type { StepTransitionDirection } from '@/components/ui/motion/resolveStepTransitionDirection';
import {
    slideTransitionTokens,
    type SlideTransitionRole,
    type SlideTransitionRoleTokens,
} from '@/components/ui/motion/slideTransitionTokens';

type SoftSlideTransitionLayer = Readonly<{
    children: React.ReactNode;
    direction: StepTransitionDirection;
    key: string | number;
}>;

type SoftSlideLayers = Readonly<{
    current: SoftSlideTransitionLayer;
    exit: SoftSlideTransitionLayer | null;
}>;

/** Keep keyed slide wrappers in the same sibling list while their visual role changes. */
function useSoftSlideLayers(props: SoftSlideTransitionFrameProps) {
    const [stored, setStored] = React.useState<SoftSlideLayers>(() => ({
        current: { key: props.transitionKey, children: props.children, direction: props.direction },
        exit: null,
    }));
    let layers = stored;
    if (stored.current.key !== props.transitionKey) {
        layers = {
            current: { key: props.transitionKey, children: props.children, direction: props.direction },
            exit: { ...stored.current, direction: props.direction },
        };
        setStored(layers);
    } else if (stored.current.children !== props.children) {
        layers = { ...stored, current: { ...stored.current, children: props.children } };
        setStored(layers);
    }
    const completeExit = React.useCallback((currentKey: string | number) => {
        setStored((previous) => previous.current.key === currentKey && previous.exit
            ? { ...previous, exit: null }
            : previous);
    }, []);
    return { layers, completeExit };
}

function layerReactKey(key: string | number): string {
    return `${typeof key}:${key}`;
}

export type SoftSlideTransitionFrameProps = Readonly<{
    children: React.ReactNode;
    contentStyle?: StyleProp<ViewStyle>;
    direction: StepTransitionDirection;
    reducedMotion: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    transitionKey: string | number;
    /** Defaults to `'signature'`; `StepTransitionFrame` owns the `'routine'` step body. */
    preset?: SlideTransitionRole;
    /**
     * Views that stay mounted, hidden, while they are neither current nor leaving (a sheet's own view
     * under a view pushed inside it). A retained view slides out and back in without a remount.
     */
    retainedLayers?: ReadonlyArray<SoftSlideRetainedLayer>;
}>;

export type SoftSlideRetainedLayer = Readonly<{ key: string | number; children: React.ReactNode }>;

/** The retained layers that are neither current nor leaving: mounted, hidden, out of the accessibility tree. */
function renderRetainedLayers(
    props: SoftSlideTransitionFrameProps,
    layers: SoftSlideLayers,
    LayerView: React.ElementType,
): React.ReactElement[] {
    return (props.retainedLayers ?? []).filter((layer) => layer.key !== layers.current.key && layer.key !== layers.exit?.key)
        .map((layer) => (
            <LayerView
                key={layerReactKey(layer.key)}
                pointerEvents="none"
                aria-hidden={true}
                accessibilityElementsHidden={true}
                importantForAccessibility="no-hide-descendants"
                style={RETAINED_LAYER_HIDDEN}
            >
                {layer.children}
            </LayerView>
        ));
}

const RETAINED_LAYER_HIDDEN = { display: 'none' } as const;

/** A leaving layer shows its last children, unless it is retained: a retained view stays live while it leaves. */
function exitChildren(props: SoftSlideTransitionFrameProps, exitLayer: SoftSlideTransitionLayer): React.ReactNode {
    const retained = props.retainedLayers?.find((layer) => layer.key === exitLayer.key);
    return retained ? retained.children : exitLayer.children;
}

const USE_NATIVE_DRIVER = Platform.OS !== 'web';

type WebSlidePhase = 'idle' | 'prepare' | 'animate';

const stylesheet = StyleSheet.create({
    container: {
        width: '100%',
        overflow: 'hidden',
        position: 'relative',
    },
    currentLayer: {
        width: '100%',
    },
    exitLayer: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 1,
    },
    blurFill: {
        ...StyleSheet.absoluteFillObject,
    },
});

function enterOffset(direction: StepTransitionDirection, translatePx: number): number {
    if (direction === 'forward') return translatePx;
    if (direction === 'backward') return -translatePx;
    return 0;
}

function exitOffset(direction: StepTransitionDirection, translatePx: number): number {
    if (direction === 'forward') return -translatePx;
    if (direction === 'backward') return translatePx;
    return 0;
}

function cssTransitionStyle(
    phase: 'enter' | 'exit',
    reducedMotion: boolean,
    roleTokens: SlideTransitionRoleTokens,
): StyleProp<ViewStyle> {
    return {
        transitionDelay: '0ms',
        transitionDuration: `${reducedMotion
            ? roleTokens.reducedMotionDurationMs
            : phase === 'enter'
                ? roleTokens.timed.durationMs.enter
                : roleTokens.timed.durationMs.exit}ms`,
        transitionProperty: 'opacity, transform, filter',
        transitionTimingFunction: roleTokens.timed.easingCss,
        willChange: 'opacity, transform, filter',
    } as unknown as StyleProp<ViewStyle>;
}

export function SoftSlideTransitionFrame(props: SoftSlideTransitionFrameProps) {
    if (Platform.OS === 'web') {
        return <WebSoftSlideTransitionFrame {...props} />;
    }
    return <NativeSoftSlideTransitionFrame {...props} />;
}

function WebSoftSlideTransitionFrame(props: SoftSlideTransitionFrameProps) {
    const styles = stylesheet;
    const roleTokens = slideTransitionTokens[props.preset ?? 'signature'];
    const transitionTokens = roleTokens.timed;
    const lastKeyRef = React.useRef(props.transitionKey);
    const { layers, completeExit } = useSoftSlideLayers(props);
    const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const frameRef = React.useRef<ReturnType<typeof setTimeout> | number | null>(null);
    const [phase, setPhase] = React.useState<WebSlidePhase>('idle');
    const exitLayer = layers.exit;

    React.useEffect(() => {
        return () => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            if (frameRef.current != null) {
                if (typeof cancelAnimationFrame === 'function' && typeof frameRef.current === 'number') {
                    cancelAnimationFrame(frameRef.current);
                } else {
                    clearTimeout(frameRef.current as ReturnType<typeof setTimeout>);
                }
            }
        };
    }, []);

    React.useLayoutEffect(() => {
        if (lastKeyRef.current === props.transitionKey) {
            return;
        }
        lastKeyRef.current = props.transitionKey;

        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }

        setPhase('prepare');

        const scheduleFrame = (callback: () => void) => {
            if (typeof requestAnimationFrame === 'function') {
                return requestAnimationFrame(() => {
                    frameRef.current = requestAnimationFrame(() => {
                        frameRef.current = null;
                        callback();
                    });
                });
            }
            return setTimeout(callback, 16);
        };

        frameRef.current = scheduleFrame(() => {
            setPhase('animate');
        });

        timeoutRef.current = setTimeout(() => {
            timeoutRef.current = null;
            completeExit(props.transitionKey);
            setPhase('idle');
        }, props.reducedMotion ? roleTokens.reducedMotionDurationMs : transitionTokens.durationMs.enter);
    }, [completeExit, props.direction, props.reducedMotion, props.transitionKey, roleTokens]);

    const currentOffset = !props.reducedMotion && phase === 'prepare'
        ? enterOffset(props.direction, transitionTokens.translatePx)
        : 0;
    const exitOffsetX = !props.reducedMotion && exitLayer && phase === 'animate'
        ? exitOffset(exitLayer.direction, transitionTokens.translatePx)
        : 0;
    const currentBlur = !props.reducedMotion && phase === 'prepare' ? transitionTokens.blurPx : 0;
    const exitBlur = !props.reducedMotion && exitLayer && phase === 'animate' ? transitionTokens.blurPx : 0;
    const currentOpacity = phase === 'prepare' ? 0 : 1;
    const exitOpacity = exitLayer && phase === 'animate' ? 0 : 1;

    return (
        <View style={[styles.container, props.style]} testID={props.testID}>
            {/* One flat keyed list: a layer moving between current, leaving and retained keeps its mount. */}
            {[exitLayer ? (
                <View
                    key={layerReactKey(exitLayer.key)}
                    pointerEvents="none"
                    aria-hidden={true}
                    accessibilityElementsHidden={true}
                    importantForAccessibility="no-hide-descendants"
                    style={[
                        styles.exitLayer,
                        cssTransitionStyle('exit', props.reducedMotion, roleTokens),
                        {
                            opacity: exitOpacity,
                            filter: `blur(${exitBlur}px)`,
                            transform: [{ translateX: exitOffsetX }],
                        } as unknown as ViewStyle,
                    ]}
                    testID={props.testID ? `${props.testID}-exit-layer` : undefined}
                >
                    {exitChildren(props, exitLayer)}
                </View>
            ) : null,
            <View
                key={layerReactKey(layers.current.key)}
                style={[
                    styles.currentLayer,
                    props.contentStyle,
                    cssTransitionStyle('enter', props.reducedMotion, roleTokens),
                    {
                        opacity: currentOpacity,
                        filter: `blur(${currentBlur}px)`,
                        transform: [{ translateX: currentOffset }],
                    } as unknown as ViewStyle,
                ]}
                testID={props.testID ? `${props.testID}-current-layer` : undefined}
            >
                {layers.current.children}
            </View>,
            ...renderRetainedLayers(props, layers, View)]}
        </View>
    );
}

function NativeSlideBlurOverlay(props: Readonly<{
    intensity: number;
    opacity: Animated.AnimatedInterpolation<string | number>;
}>): React.ReactElement | null {
    const styles = stylesheet;
    const NativeBlurView = getBlurViewComponent();
    if (!NativeBlurView) return null;

    return (
        <Animated.View
            pointerEvents="none"
            style={[styles.blurFill, { opacity: props.opacity }]}
        >
            <NativeBlurView
                intensity={props.intensity}
                style={styles.blurFill}
                tint="default"
            />
        </Animated.View>
    );
}

function NativeSoftSlideTransitionFrame(props: SoftSlideTransitionFrameProps) {
    const styles = stylesheet;
    const roleTokens = slideTransitionTokens[props.preset ?? 'signature'];
    const transitionTokens = roleTokens.timed;
    const enterProgress = React.useRef(new Animated.Value(1)).current;
    const exitProgress = React.useRef(new Animated.Value(0)).current;
    const lastKeyRef = React.useRef(props.transitionKey);
    const { layers, completeExit } = useSoftSlideLayers(props);
    const transitionRunRef = React.useRef(0);
    const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const exitLayer = layers.exit;

    React.useEffect(() => {
        return () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
        };
    }, []);

    React.useLayoutEffect(() => {
        if (lastKeyRef.current === props.transitionKey) {
            return;
        }
        lastKeyRef.current = props.transitionKey;

        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }

        enterProgress.setValue(0);
        exitProgress.setValue(0);
        transitionRunRef.current += 1;
        const transitionRun = transitionRunRef.current;

        Animated.parallel([
            Animated.timing(enterProgress, {
                toValue: 1,
                duration: props.reducedMotion ? roleTokens.reducedMotionDurationMs : transitionTokens.durationMs.enter,
                easing: transitionTokens.easing,
                useNativeDriver: USE_NATIVE_DRIVER,
            }),
            Animated.timing(exitProgress, {
                toValue: 1,
                duration: props.reducedMotion ? roleTokens.reducedMotionDurationMs : transitionTokens.durationMs.exit,
                easing: transitionTokens.easingExit,
                useNativeDriver: USE_NATIVE_DRIVER,
            }),
        ]).start();

        timeoutRef.current = setTimeout(() => {
            timeoutRef.current = null;
            if (transitionRun === transitionRunRef.current) {
                completeExit(props.transitionKey);
            }
        }, props.reducedMotion ? roleTokens.reducedMotionDurationMs : transitionTokens.durationMs.enter);
    }, [
        enterProgress,
        exitProgress,
        completeExit,
        props.direction,
        props.reducedMotion,
        props.transitionKey,
        roleTokens,
    ]);

    const enterTranslateX = enterProgress.interpolate({
        inputRange: [0, 1],
        outputRange: [props.reducedMotion ? 0 : enterOffset(props.direction, transitionTokens.translatePx), 0],
    });
    const exitTranslateX = exitLayer
        ? exitProgress.interpolate({
            inputRange: [0, 1],
            outputRange: [0, props.reducedMotion ? 0 : exitOffset(exitLayer.direction, transitionTokens.translatePx)],
        })
        : 0;

    return (
        <View style={[styles.container, props.style]} testID={props.testID}>
            {/* One flat keyed list: a layer moving between current, leaving and retained keeps its mount. */}
            {[exitLayer ? (
                <Animated.View
                    key={layerReactKey(exitLayer.key)}
                    pointerEvents="none"
                    aria-hidden={true}
                    accessibilityElementsHidden={true}
                    importantForAccessibility="no-hide-descendants"
                    style={[
                        styles.exitLayer,
                        {
                            opacity: exitProgress.interpolate({
                                inputRange: [0, 1],
                                outputRange: [1, 0],
                            }),
                            transform: [{ translateX: exitTranslateX }],
                        },
                    ]}
                    testID={props.testID ? `${props.testID}-exit-layer` : undefined}
                >
                    {exitChildren(props, exitLayer)}
                    {props.reducedMotion || transitionTokens.nativeBlurIntensity === 0 ? null : (
                        <NativeSlideBlurOverlay
                            intensity={transitionTokens.nativeBlurIntensity}
                            opacity={exitProgress.interpolate({
                                inputRange: [0, 1],
                                outputRange: [0, 1],
                            })}
                        />
                    )}
                </Animated.View>
            ) : null,
            <Animated.View
                key={layerReactKey(layers.current.key)}
                style={[
                    styles.currentLayer,
                    props.contentStyle,
                    {
                        opacity: enterProgress,
                        transform: [{ translateX: enterTranslateX }],
                    },
                ]}
                testID={props.testID ? `${props.testID}-current-layer` : undefined}
            >
                {layers.current.children}
                {props.reducedMotion || transitionTokens.nativeBlurIntensity === 0 ? null : (
                    <NativeSlideBlurOverlay
                        intensity={transitionTokens.nativeBlurIntensity}
                        opacity={enterProgress.interpolate({
                            inputRange: [0, 1],
                            outputRange: [1, 0],
                        })}
                    />
                )}
            </Animated.View>,
            ...renderRetainedLayers(props, layers, Animated.View)]}
        </View>
    );
}
