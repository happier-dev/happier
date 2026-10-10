import * as React from 'react';
import { View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { measure, useAnimatedRef } from 'react-native-reanimated';
import {
    HAPPIER_FLOATING_FRAME_METRICS,
    resolveFloatingFrameRect,
    type HappierFloatingFrameNativeBindingProps,
} from '@happier-dev/plugin-ui/presentation';

import { RetainedPresentationNativeMotionContext } from '@/components/ui/presentation/retainedPresentationSlots';
import { useCompanionNoDragRegions } from './CompanionNoDragRegion';
import { useCompanionNativePanGesture } from './useCompanionNativePanGesture';

/** Native dependency/measurement adapter. All pan and spring state stays in the companion owner. */
export function NativeFloatingFrame(props: HappierFloatingFrameNativeBindingProps): React.ReactElement {
    const nativeRef = useAnimatedRef<View>();
    const noDragRegions = useCompanionNoDragRegions();
    const { rect, availableRect, avoidRects, aspectRatio, chromeHeight, minWidth, bodyRect } = props;
    const enabled = props.mode === 'floating' && props.moveInput === 'surface';
    const bounds = React.useMemo(() => ({
        minX: availableRect.x, maxX: Math.max(availableRect.x, availableRect.x + availableRect.width - rect.width),
        minY: availableRect.y, maxY: Math.max(availableRect.y, availableRect.y + availableRect.height - rect.height),
    }), [availableRect, rect.width, rect.height]);
    const pan = useCompanionNativePanGesture({
        enabled,
        bounds,
        initialPoint: { x: rect.x, y: rect.y },
        noDragRegions,
        // Buttons/footer/grip keep their own input. Admission uses the transformed frame's actual
        // window position, rather than the settled rect or a stale onLayout screen measurement.
        canStartAt: (point) => {
            'worklet';
            const measured = measure(nativeRef);
            if (!measured) return false;
            const x = point.x - measured.pageX;
            const y = point.y - measured.pageY;
            const bodyTop = bodyRect.y - rect.y;
            const bodyBottom = bodyTop + bodyRect.height;
            const grip = HAPPIER_FLOATING_FRAME_METRICS.gripSize * 2;
            return x >= 0 && x <= rect.width && y >= bodyTop && y <= bodyBottom
                && !(x <= grip && y >= bodyBottom - grip);
        },
        releaseMotion: props.releaseMotion,
        motionPolicy: props.reducedMotion ? 'snap' : 'animate',
        positionPublication: 'release',
        resolveReleaseTarget: ({ released, projected }) => {
            'worklet';
            const placement = resolveFloatingFrameRect({
                rect: { ...rect, ...released }, availableRect, avoidRects,
                aspectRatio, chromeHeight, minWidth, projectedPoint: projected,
            });
            return placement.fits ? { x: placement.rect.x, y: placement.rect.y } : released;
        },
        onDragRelease: ({ target }) => {
            const placement = resolveFloatingFrameRect({
                rect: { ...rect, ...target }, availableRect, avoidRects, aspectRatio, chromeHeight, minWidth,
            });
            if (placement.fits) props.onRectChange(placement.rect, { kind: 'settle' });
            else props.onModeChange('docked');
        },
    });
    const motion = React.useMemo(() => ({
        x: pan.translateX, y: pan.translateY, anchorX: rect.x, anchorY: rect.y,
    }), [pan.translateX, pan.translateY, rect.x, rect.y]);

    return <RetainedPresentationNativeMotionContext.Provider value={props.mode === 'docked' ? null : motion}>
        <GestureDetector gesture={pan.gesture}>
            <Animated.View ref={nativeRef} collapsable={false} style={props.mode === 'docked' ? undefined : [
                { position: 'absolute', left: 0, top: 0, width: rect.width, height: rect.height },
                pan.animatedStyle,
            ]}>
                {props.children}
            </Animated.View>
        </GestureDetector>
    </RetainedPresentationNativeMotionContext.Provider>;
}
