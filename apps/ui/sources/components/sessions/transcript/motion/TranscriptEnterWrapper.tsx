import * as React from 'react';
import { Animated, Platform } from 'react-native';

import { motionTokens } from '@/components/ui/motion/motionTokens';

import { useTranscriptMotion } from './TranscriptMotionContext';

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

    React.useEffect(() => {
        if (!shouldAnimate) return;
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
    }, [opacity, runtime?.config.preset, shouldAnimate, translateY]);

    if (!shouldAnimate) {
        return <>{props.children}</>;
    }

    return (
        <Animated.View style={{ opacity, transform: animateTranslateOnWeb ? [{ translateY }] : undefined }}>
            {props.children}
        </Animated.View>
    );
});
