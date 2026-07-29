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

    const shouldPrepareEnterRef = React.useRef(
        runtime != null &&
        runtime.config.preset !== 'off' &&
        runtime.config.animateNewItemsEnabled === true &&
        runtime.gate.isFresh({ id: props.id, createdAt: props.createdAt }),
    );

    if (!shouldPrepareEnterRef.current || runtime == null) {
        return <>{props.children}</>;
    }

    return (
        <AnimatedTranscriptEnterWrapper
            id={props.id}
            createdAt={props.createdAt}
            runtime={runtime}
        >
            {props.children}
        </AnimatedTranscriptEnterWrapper>
    );
});

const AnimatedTranscriptEnterWrapper = React.memo(function AnimatedTranscriptEnterWrapper(props: {
    id: string;
    createdAt: number;
    runtime: NonNullable<ReturnType<typeof useTranscriptMotion>>;
    children: React.ReactNode;
}) {
    const runtime = props.runtime;
    const opacity = React.useRef(new Animated.Value(0)).current;
    const animateTranslateOnWeb = Platform.OS !== 'web';
    const translateY = React.useRef(new Animated.Value(animateTranslateOnWeb ? 6 : 0)).current;
    const animationStartedRef = React.useRef(false);
    const cancelScheduledStartRef = React.useRef<(() => void) | null>(null);
    const shouldAnimateRef = React.useRef<boolean | null>(null);

    React.useLayoutEffect(() => {
        if (shouldAnimateRef.current == null) {
            shouldAnimateRef.current = runtime.gate.consumeFreshness({
                id: props.id,
                createdAt: props.createdAt,
            });
        }

        if (shouldAnimateRef.current !== true) {
            opacity.setValue(1);
            translateY.setValue(0);
        }
    }, [opacity, props.createdAt, props.id, runtime.gate, translateY]);

    const startEnterAnimation = React.useCallback(() => {
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
    }, [animateTranslateOnWeb, opacity, runtime?.config.preset, translateY]);

    const handleLayout = React.useCallback(() => {
        if (shouldAnimateRef.current !== true) return;
        if (animationStartedRef.current) return;
        if (cancelScheduledStartRef.current) return;

        cancelScheduledStartRef.current = scheduleNextVisualFrame(() => {
            cancelScheduledStartRef.current = null;
            startEnterAnimation();
        });
    }, [startEnterAnimation]);

    React.useEffect(() => {
        return () => {
            cancelScheduledStartRef.current?.();
            cancelScheduledStartRef.current = null;
        };
    }, []);

    return (
        <Animated.View onLayout={handleLayout} style={{ opacity, transform: animateTranslateOnWeb ? [{ translateY }] : undefined }}>
            {props.children}
        </Animated.View>
    );
});
