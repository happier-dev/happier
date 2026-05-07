import * as React from 'react';
import { Animated, Platform } from 'react-native';

import { motionTokens } from '@/components/ui/motion/motionTokens';

import { useTranscriptMotion } from './TranscriptMotionContext';

function scheduleNextVisualFrame(callback: () => void): () => void {
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== 'function') {
        callback();
        return () => {};
    }

    let cancelled = false;
    const id = raf(() => {
        if (!cancelled) {
            callback();
        }
    });

    return () => {
        cancelled = true;
        globalThis.cancelAnimationFrame?.(id);
    };
}

export const TranscriptEnterWrapper = React.memo(function TranscriptEnterWrapper(props: {
    id: string;
    createdAt: number;
    children: React.ReactNode;
}) {
    const runtime = useTranscriptMotion();

    const shouldAnimateRef = React.useRef<boolean | null>(null);
    if (shouldAnimateRef.current == null) {
        const cfg = runtime?.config;
        const eligible =
            cfg != null &&
            cfg.preset !== 'off' &&
            cfg.animateNewItemsEnabled === true;
        shouldAnimateRef.current = eligible
            ? runtime!.gate.consumeFreshness({ id: props.id, createdAt: props.createdAt })
            : false;
    }
    const shouldAnimate = shouldAnimateRef.current === true;

    const opacity = React.useRef(new Animated.Value(shouldAnimate ? 0 : 1)).current;
    const animateTranslateOnWeb = Platform.OS !== 'web';
    const translateY = React.useRef(new Animated.Value(shouldAnimate && animateTranslateOnWeb ? 6 : 0)).current;
    const animationStartedRef = React.useRef(false);
    const cancelScheduledStartRef = React.useRef<(() => void) | null>(null);

    const startEnterAnimation = React.useCallback(() => {
        if (!shouldAnimate) return;
        if (animationStartedRef.current) return;
        animationStartedRef.current = true;

        const duration =
            runtime?.config.preset === 'full'
                ? motionTokens.durationMs.base
                : motionTokens.durationMs.fast;
        const useNativeDriver = Platform.OS !== 'web';
        const anims = [
            Animated.timing(opacity, {
                toValue: 1,
                duration,
                easing: motionTokens.easing.standard,
                useNativeDriver,
            }),
        ];
        if (animateTranslateOnWeb) {
            anims.push(Animated.timing(translateY, {
                toValue: 0,
                duration,
                easing: motionTokens.easing.standard,
                useNativeDriver,
            }));
        }
        Animated.parallel(anims).start();
    }, [animateTranslateOnWeb, opacity, runtime?.config.preset, shouldAnimate, translateY]);

    const handleLayout = React.useCallback(() => {
        if (!shouldAnimate) return;
        if (animationStartedRef.current) return;
        if (cancelScheduledStartRef.current) return;

        cancelScheduledStartRef.current = scheduleNextVisualFrame(() => {
            cancelScheduledStartRef.current = null;
            startEnterAnimation();
        });
    }, [shouldAnimate, startEnterAnimation]);

    React.useEffect(() => {
        return () => {
            cancelScheduledStartRef.current?.();
            cancelScheduledStartRef.current = null;
        };
    }, []);

    if (!shouldAnimate) {
        return <>{props.children}</>;
    }

    return (
        <Animated.View onLayout={handleLayout} style={{ opacity, transform: animateTranslateOnWeb ? [{ translateY }] : undefined }}>
            {props.children}
        </Animated.View>
    );
});
