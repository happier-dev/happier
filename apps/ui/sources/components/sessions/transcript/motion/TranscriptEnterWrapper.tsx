import * as React from 'react';
import { Animated, Platform } from 'react-native';

import { motionTokens } from '@/components/ui/motion/motionTokens';

import { useTranscriptMotion } from './TranscriptMotionContext';

export const TranscriptEnterWrapper = React.memo(function TranscriptEnterWrapper(props: {
    id: string;
    createdAt: number;
    paintedIds?: readonly string[] | null;
    children: React.ReactNode;
}) {
    const runtime = useTranscriptMotion();
    const paintedIds = props.paintedIds ?? null;

    const shouldPrepareEnterRef = React.useRef(
        runtime != null &&
        runtime.config.preset !== 'off' &&
        runtime.config.animateNewItemsEnabled === true &&
        runtime.gate.isFresh({ id: props.id, createdAt: props.createdAt, paintedIds }),
    );

    const gate = runtime?.gate;
    const paintedIdsRef = React.useRef(paintedIds);
    paintedIdsRef.current = paintedIds;
    const paintedIdsKey = paintedIds ? paintedIds.join('\u0000') : '';
    React.useEffect(() => {
        if (paintedIdsKey.length === 0) return;
        gate?.markPainted(paintedIdsRef.current);
    }, [gate, paintedIdsKey]);

    if (!shouldPrepareEnterRef.current || runtime == null) {
        return <>{props.children}</>;
    }

    return (
        <AnimatedTranscriptEnterWrapper
            id={props.id}
            createdAt={props.createdAt}
            paintedIds={paintedIds}
            runtime={runtime}
        >
            {props.children}
        </AnimatedTranscriptEnterWrapper>
    );
});

/**
 * A fresh row enters by FADE ONLY, on every platform.
 *
 * J/D4 (2026-07-30) — deliberate decision, recorded because the previous code hid the opposite one
 * behind a misnamed flag: `const animateTranslateOnWeb = Platform.OS !== 'web'` is TRUE on native,
 * so native rows faded AND slid 6px while web rows only faded. The 6px slide is removed rather than
 * renamed. Reasons: (1) the reason web opted out — a row translated toward its neighbour briefly
 * overlaps it and intercepts touches — is a platform-neutral hazard, not a web one; (2) a send
 * creates two fresh rows (the pending row, then its committed twin), so it was two native-only 6px
 * movements inside exactly the window whose movement the user is objecting to, on top of the
 * measured MVCP excursion at that handover; (3) it removes a native/web asymmetry that no product
 * decision asked for. Whether new rows animate at all remains owned by the motion preset /
 * `animateNewItemsEnabled`, not by a platform check here.
 */
const AnimatedTranscriptEnterWrapper = React.memo(function AnimatedTranscriptEnterWrapper(props: {
    id: string;
    createdAt: number;
    paintedIds: readonly string[] | null;
    runtime: NonNullable<ReturnType<typeof useTranscriptMotion>>;
    children: React.ReactNode;
}) {
    const runtime = props.runtime;
    const opacity = React.useRef(new Animated.Value(0)).current;
    const animationStartedRef = React.useRef(false);
    const shouldAnimateRef = React.useRef<boolean | null>(null);

    const startEnterAnimation = React.useCallback(() => {
        if (animationStartedRef.current) return;
        animationStartedRef.current = true;

        const duration =
            runtime?.config.preset === 'full'
                ? motionTokens.durationMs.base
                : motionTokens.durationMs.fast;
        const useNativeDriver = Platform.OS !== 'web';
        Animated.timing(opacity, {
            toValue: 1,
            duration,
            easing: motionTokens.easing.standard,
            useNativeDriver,
        }).start();
    }, [opacity, runtime?.config.preset]);

    React.useLayoutEffect(() => {
        if (shouldAnimateRef.current == null) {
            shouldAnimateRef.current = runtime.gate.consumeFreshness({
                id: props.id,
                createdAt: props.createdAt,
                paintedIds: props.paintedIds,
            });
        }

        if (shouldAnimateRef.current !== true) {
            opacity.setValue(1);
            return;
        }

        startEnterAnimation();
    }, [opacity, props.createdAt, props.id, props.paintedIds, runtime.gate, startEnterAnimation]);

    return (
        <Animated.View style={{ opacity }}>
            {props.children}
        </Animated.View>
    );
});
