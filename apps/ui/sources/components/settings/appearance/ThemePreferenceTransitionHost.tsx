import React from 'react';
import MaskedView from '@react-native-masked-view/masked-view';
import { Image, Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import Animated, {
    Easing,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { captureRef } from 'react-native-view-shot';

import { addBreadcrumbIfEnabled } from '@/utils/system/sentry';
import { createNativeThemePreferenceTransitionController } from './nativeThemePreferenceTransitionController';
import { registerNativeThemePreferenceTransitionController } from './themePreferenceTransition';
import {
    THEME_TRANSITION_DURATION_MS,
    THEME_TRANSITION_EASING_BEZIER,
} from './themePreferenceTransitionMotion';

function waitForFrame(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                resolve();
            });
        });
    });
}

function recordNativeThemeTransitionBreadcrumb(data: Readonly<{ phase: string }>): void {
    addBreadcrumbIfEnabled({
        category: 'theme.nativeTransition',
        level: 'info',
        data,
    });
}

export function ThemePreferenceTransitionHost(props: Readonly<{ children: React.ReactNode }>) {
    const surfaceRef = React.useRef<View>(null);
    const [overlayUri, setOverlayUri] = React.useState<string | null>(null);
    const [surfaceHeight, setSurfaceHeight] = React.useState(0);
    const revealProgress = useSharedValue(0);

    const maskStyle = useAnimatedStyle(() => ({
        flex: 1,
        backgroundColor: 'black',
        transform: [{ translateY: revealProgress.value * surfaceHeight }],
    }));

    const captureSurface = React.useCallback(async () => {
        if (Platform.OS === 'web') return null;
        if (!surfaceRef.current) return null;
        try {
            return await captureRef(surfaceRef, {
                format: 'png',
                quality: 1,
                result: 'tmpfile',
            });
        } catch {
            return null;
        }
    }, []);

    const animateOverlay = React.useCallback(() => {
        return new Promise<void>((resolve) => {
            revealProgress.value = withTiming(
                1,
                {
                    duration: THEME_TRANSITION_DURATION_MS,
                    easing: Easing.bezier(...THEME_TRANSITION_EASING_BEZIER),
                },
                () => {
                    runOnJS(resolve)();
                },
            );
        });
    }, [revealProgress]);

    React.useEffect(() => {
        if (Platform.OS === 'web') return;
        return registerNativeThemePreferenceTransitionController(
            createNativeThemePreferenceTransitionController({
                animateOverlay,
                captureSurface,
                hideOverlay: () => {
                    setOverlayUri(null);
                    revealProgress.value = 0;
                },
                showOverlay: (uri) => {
                    revealProgress.value = 0;
                    setOverlayUri(uri);
                },
                recordBreadcrumb: recordNativeThemeTransitionBreadcrumb,
                waitForFrame,
            }),
        );
    }, [animateOverlay, captureSurface, revealProgress]);

    return (
        <View
            ref={surfaceRef}
            collapsable={false}
            style={{ flex: 1 }}
            onLayout={(event) => {
                setSurfaceHeight(event.nativeEvent.layout.height);
            }}
        >
            {props.children}
            {Platform.OS !== 'web' && overlayUri ? (
                <MaskedView
                    pointerEvents="none"
                    style={{
                        ...StyleSheet.absoluteFillObject,
                        zIndex: 9999,
                    }}
                    maskElement={<Animated.View style={maskStyle} />}
                >
                    <Image
                        source={{ uri: overlayUri }}
                        style={StyleSheet.absoluteFillObject}
                        resizeMode="stretch"
                    />
                </MaskedView>
            ) : null}
        </View>
    );
}
