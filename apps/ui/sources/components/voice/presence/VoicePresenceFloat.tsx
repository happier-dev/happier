import * as React from 'react';
import type { FrameRect } from '@happier-dev/plugin-ui/presentation';
import { Platform, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { useCompanionNoDragRegions } from '@/components/companion/interaction/CompanionNoDragRegion';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { useVoicePresenceDrag, type VoicePresenceDragRelease } from './useVoicePresenceDrag';
import { resolveVoicePresenceGeometry, resolveVoicePresenceBottomReservation } from './voicePresenceGeometry';

/** Held, a floating container lifts 6 % (lab I/Id), the same lift the orb has always had. */
const LIFT_SCALE = 0.06;

/** Web DOM hooks for the shared pointer-drag session: the capsule is the handle, controls are not. */
export const VOICE_PRESENCE_POINTER_SELECTORS = Object.freeze({
    noDrag: '[data-voice-presence-no-drag="true"], .no-drag',
    handle: '[data-voice-presence-handle="true"]',
});

/** Spread on a container's controls so a press there never starts a drag on web. */
export const VOICE_PRESENCE_NO_DRAG_PROPS = Platform.OS === 'web'
    ? ({ dataSet: { voicePresenceNoDrag: 'true' } } as const)
    : ({} as const);

export type VoicePresenceFloatRender = Readonly<{
    /** A drag past threshold suppresses the tap that would otherwise follow it. */
    shouldSuppressPress: () => boolean;
    /** The container's live x, for content that faces the window's centre (the orb's caption). */
    translateX: SharedValue<number>;
    hostWidth: number;
}>;

/**
 * The one floating host for Island and Orb (§4.3): positions a measured container inside the
 * app's overlay, clear of the shell's bottom chrome, and moves it with the shared Companion drag
 * physics (`useVoicePresenceDrag` — velocity projection, critically damped per-axis springs,
 * release velocity carried). Containers own their content; placement and motion live here once.
 */
export const VoicePresenceFloat = React.memo(function VoicePresenceFloat(props: Readonly<{
    /** The container's own size, so bounds are measured rather than assumed. */
    width: number;
    height: number;
    /** Everything the shell keeps at the bottom (bar, composer, keyboard, safe area). */
    restingBottomInset: number;
    /** Distance from the host's edges at rest and while dragged. */
    edgeInset: number;
    /** Highest the container may climb (clears the title strip / status bar). */
    minimumTop: number;
    /** Physical native hit area around the logical container; does not alter its dock/drag anchor. */
    interactionPaddingHorizontal?: number;
    /** Centre the resting point horizontally (phone island) instead of the trailing corner. */
    restCentred?: boolean;
    anchors?: 'orb' | 'island';
    bottomChromeInset?: number;
    onBottomReservationChange?: (height: number) => void;
    viewerRect?: FrameRect | null;
    avoidRects?: readonly FrameRect[];
    /** Publish settled measured geometry to the existing shell owner, never pointer samples. */
    onRectChange?: (rect: FrameRect | null) => void;
    testID?: string;
    children: (render: VoicePresenceFloatRender) => React.ReactNode;
}>): React.ReactElement {
    const reduced = useReducedMotionPreference();
    const noDragRegions = useCompanionNoDragRegions();
    const [host, setHost] = React.useState({ w: 0, h: 0 });
    const [containerSize, setContainerSize] = React.useState<{ width: number; height: number } | null>(null);
    const [bottomDocked, setBottomDocked] = React.useState(true);
    const passthrough = resolveOverlayPointerEvents(Platform.OS === 'web' ? 'none' : 'box-none');
    const interactionPadding = props.interactionPaddingHorizontal ?? 0;
    const interactive = resolveOverlayPointerEvents(interactionPadding > 0 ? 'box-none' : 'auto');

    const width = containerSize?.width ?? props.width;
    const height = containerSize?.height ?? props.height;
    const avoidRects = React.useMemo(() => props.viewerRect
        ? [...(props.avoidRects ?? []), props.viewerRect] : props.avoidRects,
    [props.avoidRects, props.viewerRect]);
    const geometry = resolveVoicePresenceGeometry({
        hostWidth: host.w,
        hostHeight: host.h,
        containerWidth: width,
        containerHeight: height,
        restingBottomInset: props.restingBottomInset,
        edgeInset: props.edgeInset,
        minimumTop: props.minimumTop,
        bottomMargin: 0,
        restCentred: props.restCentred,
        avoidRects,
    });
    const { minX, maxX, minY, maxY } = geometry.dragBounds;
    const bounds = React.useMemo(() => ({ minX, maxX, minY, maxY }), [maxX, maxY, minX, minY]);
    const restX = geometry.restingPoint.x;
    const restY = geometry.restingPoint.y;
    const initialPoint = React.useMemo(() => ({ x: restX, y: restY }), [restX, restY]);
    const onDragRelease = React.useCallback((release: VoicePresenceDragRelease) => {
        setBottomDocked(release.point.y === maxY);
        props.onRectChange?.({ ...release.point, width, height });
    }, [height, maxY, props.onRectChange, width]);
    React.useEffect(() => { setBottomDocked(initialPoint.y === maxY); }, [initialPoint, maxY]);
    const reportRect = props.onRectChange;
    React.useEffect(() => {
        if (host.w > 0 && host.h > 0) reportRect?.({ ...initialPoint, width, height });
    }, [height, host.h, host.w, initialPoint, reportRect, width]);
    React.useEffect(() => () => { reportRect?.(null); }, [reportRect]);
    const reportBottomReservation = props.onBottomReservationChange;
    const reservation = resolveVoicePresenceBottomReservation({
        hostHeight: host.h,
        point: { x: restX, y: maxY },
        containerHeight: containerSize?.height ?? 0,
        bottomChromeInset: props.bottomChromeInset ?? 0,
        dockedBottom: bottomDocked,
    });
    React.useEffect(() => {
        reportBottomReservation?.(reservation);
    }, [reportBottomReservation, reservation]);

    const drag = useVoicePresenceDrag({
        bounds,
        initialPoint,
        noDragRegions,
        onDragRelease,
        motionPolicy: reduced ? 'snap' : 'animate',
        pointerSelectors: VOICE_PRESENCE_POINTER_SELECTORS,
        anchors: props.anchors,
        containerSize: React.useMemo(() => ({ width, height }), [height, width]),
        avoidRects,
    });
    const gesture = React.useMemo(() => drag.gesture.enabled(Platform.OS !== 'web'), [drag.gesture]);
    const { translateX, translateY, dragProgress } = drag;
    const style = useAnimatedStyle(() => ({
        transform: [
            { translateX: translateX.get() },
            { translateY: translateY.get() },
            { scale: 1 + dragProgress.get() * LIFT_SCALE },
        ],
    }));

    const measured = host.w > 0 && host.h > 0;
    return (
        <View
            testID={props.testID}
            pointerEvents={passthrough.nativePointerEvents}
            style={[{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }, passthrough.webStyle]}
            onLayout={(event) => {
                const { width, height } = event.nativeEvent.layout;
                setHost((current) => (current.w === Math.round(width) && current.h === Math.round(height)
                    ? current
                    : { w: Math.round(width), h: Math.round(height) }));
            }}
        >
            {measured ? (
                <GestureDetector gesture={gesture}>
                    <Animated.View
                        testID="voice-presence-float-body"
                        ref={drag.dragTargetRef}
                        pointerEvents={interactive.nativePointerEvents}
                        onLayout={(event) => {
                            const { width: physicalWidth, height } = event.nativeEvent.layout;
                            const width = Math.max(0, physicalWidth - 2 * interactionPadding);
                            setContainerSize((current) => current?.width === width && current.height === height
                                ? current : { width, height });
                        }}
                        style={[
                            { position: 'absolute', left: -interactionPadding, top: 0, width: props.width + 2 * interactionPadding, height: props.height },
                            interactive.webStyle,
                            style,
                        ]}
                        {...(Platform.OS === 'web' ? { dataSet: { voicePresenceHandle: 'true' } } : {})}
                        {...drag.pointerHandlers}
                    >
                        {props.children({ shouldSuppressPress: drag.shouldSuppressPress, translateX, hostWidth: host.w })}
                    </Animated.View>
                </GestureDetector>
            ) : null}
        </View>
    );
});
