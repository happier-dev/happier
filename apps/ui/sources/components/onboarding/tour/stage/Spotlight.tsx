import * as React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

import {
    resolvePostCameraTargetRect,
    type StageCameraTransform,
    type StageTargetRect,
} from './useStageTransform';
import {
    useRegisteredSpotlightTargetRect,
    useSpotlightTargetRegistration,
    useSpotlightTargetRegistrationChecker,
} from './useSpotlightTarget';
import type { StageWebHaloNode } from './useStageWebCamera';

export type SpotlightProps = Readonly<{
    targetId?: string | null;
    fallbackRect: StageTargetRect;
    dim?: number;
    settledCameraTransform?: StageCameraTransform;
    settledTargetRect?: StageTargetRect | null;
    externallyDriven?: boolean;
    haloRef?: React.RefObject<StageWebHaloNode | null>;
    testID?: string;
}>;

type HaloShadowStyle = ViewStyle & Readonly<{ boxShadow?: string }>;

/**
 * The single-element spotlight technique (ported from the R3 motion mock `.jhalo`):
 * a huge-spread box-shadow paints the dim scrim everywhere EXCEPT the halo's own
 * rounded rect, so ONE element is both the focus ring and the surrounding dim. The
 * dim alpha is parameterized by the beat's `dim`; the white ring + soft glow are
 * fixed. This supersedes the previous four-rect cutout overlay (D19 / spec §4): the
 * halo and camera share one settled-rect source so they can never disagree.
 */
export function buildSpotlightHaloShadow(dim: number): string {
    const dimAlpha = Math.max(0, Math.min(1, dim));
    return [
        `0 0 0 9999px rgba(4,4,6,${dimAlpha})`,
        '0 0 0 1.5px rgba(255,255,255,0.4)',
        '0 0 60px 6px rgba(255,255,255,0.08)',
    ].join(', ');
}

export function Spotlight(props: SpotlightProps): React.ReactElement {
    const testID = props.testID ?? 'stage-spotlight';
    const dim = props.dim ?? 0.55;
    const resolvedTarget = useRegisteredSpotlightTargetRect(props.targetId, props.fallbackRect);
    const settledTargetRect = React.useMemo(() => (
        props.externallyDriven
            ? resolvedTarget.rect
            : props.settledTargetRect ?? (props.settledCameraTransform
            ? resolvePostCameraTargetRect(resolvedTarget.rect, props.settledCameraTransform, props.fallbackRect)
            : resolvedTarget.rect)
    ), [
        props.externallyDriven,
        props.fallbackRect,
        props.settledCameraTransform,
        props.settledTargetRect,
        resolvedTarget.rect,
    ]);
    const targetRegistered = useSpotlightTargetRegistration(props.targetId);
    const isTargetRegistered = useSpotlightTargetRegistrationChecker();

    React.useEffect(() => {
        if (!__DEV__) return;
        if (!props.targetId || resolvedTarget.found) return;
        if (targetRegistered || isTargetRegistered(props.targetId)) return;
        console.warn(`[DemoStage] Missing spotlight target "${props.targetId}"; framing full surface.`);
    }, [props.targetId, resolvedTarget.found, targetRegistered, isTargetRegistered]);

    // Stage entry/exit already crossfades at the owning camera layer. Keeping the
    // halo opacity static here prevents a second web/native animation from being
    // stranded while a measured target changes in-place.
    const haloStyle = React.useMemo<HaloShadowStyle>(() => ({
        left: settledTargetRect.x,
        top: settledTargetRect.y,
        width: settledTargetRect.width,
        height: settledTargetRect.height,
        boxShadow: buildSpotlightHaloShadow(dim),
    }), [dim, settledTargetRect.height, settledTargetRect.width, settledTargetRect.x, settledTargetRect.y]);

    return (
        <View testID={testID} pointerEvents="none" style={styles.root}>
            {resolvedTarget.found ? (
                <Animated.View
                    ref={props.haloRef as React.Ref<never>}
                    testID={`${testID}-halo`}
                    pointerEvents="none"
                    style={[styles.halo, haloStyle]}
                />
            ) : (
                <>
                    <Animated.View
                        testID={`${testID}-overlay`}
                        pointerEvents="none"
                        style={[styles.fullOverlay, { opacity: dim }]}
                    />
                    <View
                        testID={`${testID}-fallback-frame`}
                        pointerEvents="none"
                        style={[
                            styles.fallbackFrame,
                            {
                                left: resolvedTarget.rect.x,
                                top: resolvedTarget.rect.y,
                                width: resolvedTarget.rect.width,
                                height: resolvedTarget.rect.height,
                            },
                        ]}
                    />
                </>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 30,
    },
    halo: {
        borderCurve: 'continuous',
        borderRadius: 18,
        position: 'absolute',
    },
    fullOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'black',
    },
    fallbackFrame: {
        borderColor: 'transparent',
        borderWidth: 0,
        position: 'absolute',
    },
});
