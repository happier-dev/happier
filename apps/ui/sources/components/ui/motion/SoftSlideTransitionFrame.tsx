import * as React from 'react';
import {
    Animated,
    Platform,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { StepTransitionDirection } from '@/components/ui/motion/resolveStepTransitionDirection';
import { softSlideTransitionTokens } from '@/components/ui/motion/softSlideTransitionTokens';

type SoftSlideTransitionLayer = Readonly<{
    children: React.ReactNode;
    direction: StepTransitionDirection;
    key: string | number;
}>;

export type SoftSlideTransitionFrameProps = Readonly<{
    children: React.ReactNode;
    direction: StepTransitionDirection;
    reducedMotion: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    transitionKey: string | number;
}>;

const USE_NATIVE_DRIVER = Platform.OS !== 'web';

type WebSlidePhase = 'idle' | 'prepare' | 'animate';

const stylesheet = StyleSheet.create({
    container: {
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        position: 'relative',
    },
    currentLayer: {
        flex: 1,
        minHeight: 0,
    },
    exitLayer: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 1,
    },
    blurFill: {
        ...StyleSheet.absoluteFillObject,
    },
});

function enterOffset(direction: StepTransitionDirection): number {
    if (direction === 'forward') return softSlideTransitionTokens.translatePx;
    if (direction === 'backward') return -softSlideTransitionTokens.translatePx;
    return 0;
}

function exitOffset(direction: StepTransitionDirection): number {
    if (direction === 'forward') return -softSlideTransitionTokens.translatePx;
    if (direction === 'backward') return softSlideTransitionTokens.translatePx;
    return 0;
}

type NativeBlurViewProps = Readonly<{
    children?: React.ReactNode;
    experimentalBlurMethod?: string;
    intensity?: number;
    style?: StyleProp<ViewStyle>;
    tint?: 'default' | 'light' | 'dark' | 'extraLight' | 'prominent' | 'systemUltraThinMaterial' | 'systemThinMaterial' | 'systemMaterial' | 'systemThickMaterial' | 'systemChromeMaterial' | 'systemUltraThinMaterialLight' | 'systemThinMaterialLight' | 'systemMaterialLight' | 'systemThickMaterialLight' | 'systemChromeMaterialLight' | 'systemUltraThinMaterialDark' | 'systemThinMaterialDark' | 'systemMaterialDark' | 'systemThickMaterialDark' | 'systemChromeMaterialDark';
}>;

let cachedNativeBlurView: React.ComponentType<NativeBlurViewProps> | null = null;
let pendingNativeBlurView: Promise<React.ComponentType<NativeBlurViewProps> | null> | null = null;

function cssTransitionStyle(phase: 'enter' | 'exit'): StyleProp<ViewStyle> {
    return {
        transitionDelay: '0ms',
        transitionDuration: `${phase === 'enter'
            ? softSlideTransitionTokens.durationMs.enter
            : softSlideTransitionTokens.durationMs.exit}ms`,
        transitionProperty: 'opacity, transform, filter',
        transitionTimingFunction: softSlideTransitionTokens.easingCss,
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
    const lastKeyRef = React.useRef(props.transitionKey);
    const lastChildrenRef = React.useRef(props.children);
    const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const frameRef = React.useRef<ReturnType<typeof setTimeout> | number | null>(null);
    const [phase, setPhase] = React.useState<WebSlidePhase>('idle');
    const [exitLayer, setExitLayer] = React.useState<SoftSlideTransitionLayer | null>(null);

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
            lastChildrenRef.current = props.children;
            return;
        }

        const outgoingLayer: SoftSlideTransitionLayer = {
            children: lastChildrenRef.current,
            direction: props.direction,
            key: lastKeyRef.current,
        };
        lastKeyRef.current = props.transitionKey;
        lastChildrenRef.current = props.children;

        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }

        if (props.reducedMotion) {
            setPhase('idle');
            setExitLayer(null);
            return;
        }

        setExitLayer(outgoingLayer);
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
            setExitLayer(null);
            setPhase('idle');
        }, softSlideTransitionTokens.durationMs.enter);
    }, [props.children, props.direction, props.reducedMotion, props.transitionKey]);

    const currentOffset = phase === 'prepare' ? enterOffset(props.direction) : 0;
    const exitOffsetX = exitLayer && phase === 'animate' ? exitOffset(exitLayer.direction) : 0;
    const currentBlur = phase === 'prepare' ? softSlideTransitionTokens.blurPx : 0;
    const exitBlur = exitLayer && phase === 'animate' ? softSlideTransitionTokens.blurPx : 0;
    const currentOpacity = phase === 'prepare' ? 0 : 1;
    const exitOpacity = exitLayer && phase === 'animate' ? 0 : 1;

    return (
        <View style={[styles.container, props.style]} testID={props.testID}>
            {exitLayer ? (
                <View
                    pointerEvents="none"
                    style={[
                        styles.exitLayer,
                        cssTransitionStyle('exit'),
                        {
                            opacity: exitOpacity,
                            filter: `blur(${exitBlur}px)`,
                            transform: [{ translateX: exitOffsetX }],
                        } as unknown as ViewStyle,
                    ]}
                    testID={props.testID ? `${props.testID}-exit-layer` : undefined}
                >
                    {exitLayer.children}
                </View>
            ) : null}
            <View
                style={[
                    styles.currentLayer,
                    cssTransitionStyle('enter'),
                    {
                        opacity: currentOpacity,
                        filter: `blur(${currentBlur}px)`,
                        transform: [{ translateX: currentOffset }],
                    } as unknown as ViewStyle,
                ]}
                testID={props.testID ? `${props.testID}-current-layer` : undefined}
            >
                {props.children}
            </View>
        </View>
    );
}

function NativeSlideBlurOverlay(props: Readonly<{
    opacity: Animated.AnimatedInterpolation<string | number>;
}>): React.ReactElement | null {
    const styles = stylesheet;
    const NativeBlurView = useNativeBlurViewComponent();
    if (!NativeBlurView) return null;

    return (
        <Animated.View
            pointerEvents="none"
            style={[styles.blurFill, { opacity: props.opacity }]}
        >
            <NativeBlurView
                experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
                intensity={softSlideTransitionTokens.nativeBlurIntensity}
                style={styles.blurFill}
                tint="default"
            />
        </Animated.View>
    );
}

function useNativeBlurViewComponent(): React.ComponentType<NativeBlurViewProps> | null {
    const [component, setComponent] = React.useState<React.ComponentType<NativeBlurViewProps> | null>(() => cachedNativeBlurView);

    React.useEffect(() => {
        if (cachedNativeBlurView) {
            setComponent(() => cachedNativeBlurView);
            return undefined;
        }

        let active = true;

        pendingNativeBlurView ??= import('expo-blur')
            .then((expoBlur) => {
                cachedNativeBlurView = expoBlur.BlurView as React.ComponentType<NativeBlurViewProps>;
                return cachedNativeBlurView;
            })
            .catch(() => {
                cachedNativeBlurView = null;
                return null;
            });

        void pendingNativeBlurView.then((nextComponent) => {
            if (active) {
                setComponent(() => nextComponent);
            }
        });

        return () => {
            active = false;
        };
    }, []);

    return component;
}

function NativeSoftSlideTransitionFrame(props: SoftSlideTransitionFrameProps) {
    const styles = stylesheet;
    const enterProgress = React.useRef(new Animated.Value(1)).current;
    const exitProgress = React.useRef(new Animated.Value(0)).current;
    const lastKeyRef = React.useRef(props.transitionKey);
    const lastChildrenRef = React.useRef(props.children);
    const transitionRunRef = React.useRef(0);
    const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const [exitLayer, setExitLayer] = React.useState<SoftSlideTransitionLayer | null>(null);

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
            lastChildrenRef.current = props.children;
            return;
        }

        const outgoingLayer: SoftSlideTransitionLayer = {
            children: lastChildrenRef.current,
            direction: props.direction,
            key: lastKeyRef.current,
        };
        lastKeyRef.current = props.transitionKey;
        lastChildrenRef.current = props.children;

        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }


        if (props.reducedMotion) {
            enterProgress.setValue(1);
            exitProgress.setValue(1);
            setExitLayer(null);
            return;
        }

        enterProgress.setValue(0);
        exitProgress.setValue(0);
        setExitLayer(outgoingLayer);
        transitionRunRef.current += 1;
        const transitionRun = transitionRunRef.current;

        Animated.parallel([
            Animated.timing(enterProgress, {
                toValue: 1,
                duration: softSlideTransitionTokens.durationMs.enter,
                easing: softSlideTransitionTokens.easing,
                useNativeDriver: USE_NATIVE_DRIVER,
            }),
            Animated.timing(exitProgress, {
                toValue: 1,
                duration: softSlideTransitionTokens.durationMs.exit,
                easing: softSlideTransitionTokens.easingExit,
                useNativeDriver: USE_NATIVE_DRIVER,
            }),
        ]).start();

        timeoutRef.current = setTimeout(() => {
            timeoutRef.current = null;
            if (transitionRun === transitionRunRef.current) {
                setExitLayer(null);
            }
        }, softSlideTransitionTokens.durationMs.enter);
    }, [
        enterProgress,
        exitProgress,
        props.children,
        props.direction,
        props.reducedMotion,
        props.transitionKey,
    ]);

    const enterTranslateX = enterProgress.interpolate({
        inputRange: [0, 1],
        outputRange: [enterOffset(props.direction), 0],
    });
    const exitTranslateX = exitLayer
        ? exitProgress.interpolate({
            inputRange: [0, 1],
            outputRange: [0, exitOffset(exitLayer.direction)],
        })
        : 0;

    return (
        <View style={[styles.container, props.style]} testID={props.testID}>
            {exitLayer ? (
                <Animated.View
                    pointerEvents="none"
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
                    {exitLayer.children}
                    <NativeSlideBlurOverlay
                        opacity={exitProgress.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, 1],
                        })}
                    />
                </Animated.View>
            ) : null}
            <Animated.View
                style={[
                    styles.currentLayer,
                    {
                        opacity: enterProgress,
                        transform: [{ translateX: enterTranslateX }],
                    },
                ]}
                testID={props.testID ? `${props.testID}-current-layer` : undefined}
            >
                {props.children}
                <NativeSlideBlurOverlay
                    opacity={enterProgress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, 0],
                    })}
                />
            </Animated.View>
        </View>
    );
}
