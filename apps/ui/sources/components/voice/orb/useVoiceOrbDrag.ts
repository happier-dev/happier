import * as React from 'react';
import { Platform, type View } from 'react-native';
import type { Gesture } from 'react-native-gesture-handler';
import {
    useSharedValue,
    withSpring,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';

import type { CompanionNoDragRegionRect } from '@/components/companion/interaction/CompanionNoDragRegion';
import {
    projectCompanionRelease,
    resolveCompanionReleaseSpringConfig,
} from '@/components/companion/interaction/companionReleaseMotion';
import {
    useCompanionNativePanGesture,
    type CompanionDragBounds,
    type CompanionDragMotionPolicy,
    type CompanionPoint,
} from '@/components/companion/interaction/useCompanionNativePanGesture';
import {
    useCompanionPointerDragSession,
    type CompanionPointerDragMove,
    type CompanionPointerDragRelease,
} from '@/components/companion/interaction/useCompanionPointerDragSession';
import { VOICE_MOTION } from '@/components/voice/light/voiceLightTokens';

import {
    VOICE_ORB_POINTER_DRAG_SELECTORS,
    VOICE_ORB_RELEASE_MOTION,
    clampVoiceOrbPoint,
    resolveVoiceOrbReleaseTarget,
} from './voiceOrbGeometry';

export type VoiceOrbDragRelease = Readonly<{ velocityX: number; velocityY: number }>;

export type VoiceOrbDrag = Readonly<{
    /** The native pan session. Disabled on web, where the pointer session owns the drag. */
    gesture: ReturnType<typeof Gesture.Pan>;
    translateX: SharedValue<number>;
    translateY: SharedValue<number>;
    /** 0 at rest, 1 while held. Drives the lift without re-rendering. */
    dragProgress: SharedValue<number>;
    /** Web only: the DOM node the pointer session listens on and captures against. */
    dragTargetRef: React.RefCallback<View>;
    pointerHandlers: Readonly<{ onPointerDown?: (event: unknown) => void }>;
    /** A drag past threshold cancels the tap that would otherwise follow it. */
    shouldSuppressPress: () => boolean;
}>;

/**
 * The orb's drag, on both platforms, resolved to one position.
 *
 * There is one shared drag owner per input model — `useCompanionNativePanGesture` for touch, and
 * `useCompanionPointerDragSession` for web pointers — and the orb consumed only the first. On web
 * that left the companion driven by a gesture recogniser that never sees a mouse the way the pet's
 * pointer session does, while the orb's own selectors sat unused. Both hooks are called
 * unconditionally (they are hooks), each is inert on the other's platform, and this composes them
 * into the single position, lift and tap-suppression contract `VoiceOrb` renders from — so the
 * settle spring, the throw projection and the edge snap stay identical whichever one is live.
 */
export function useVoiceOrbDrag(input: Readonly<{
    enabled?: boolean;
    bounds: CompanionDragBounds;
    initialPoint: CompanionPoint;
    noDragRegions: readonly CompanionNoDragRegionRect[];
    onDragRelease: (release: VoiceOrbDragRelease) => void;
    motionPolicy?: CompanionDragMotionPolicy;
}>): VoiceOrbDrag {
    const isWeb = Platform.OS === 'web';
    const bounds = input.bounds;
    const initialPoint = input.initialPoint;
    const onDragRelease = input.onDragRelease;
    const snapMotion = input.motionPolicy === 'snap';

    const pan = useCompanionNativePanGesture({
        bounds,
        initialPoint,
        noDragRegions: input.noDragRegions,
        releaseMotion: VOICE_ORB_RELEASE_MOTION,
        motionPolicy: input.motionPolicy,
        resolveReleaseTarget: (release) => {
            'worklet';
            return resolveVoiceOrbReleaseTarget({ projected: release.projected, bounds: release.bounds });
        },
        onDragRelease,
    });

    // The web session reports pointer deltas on the JS thread, so the orb keeps its own position
    // there rather than reaching into the native hook's shared values.
    const webX = useSharedValue(initialPoint.x);
    const webY = useSharedValue(initialPoint.y);
    const webProgress = useSharedValue(0);
    const webPointRef = React.useRef<CompanionPoint>(initialPoint);
    const boundsRef = React.useRef(bounds);
    boundsRef.current = bounds;

    React.useEffect(() => {
        if (!isWeb) return;
        webPointRef.current = initialPoint;
        webX.set(initialPoint.x);
        webY.set(initialPoint.y);
    }, [initialPoint, isWeb, webX, webY]);

    const handleWebMove = React.useCallback((move: CompanionPointerDragMove) => {
        const next = clampVoiceOrbPoint({
            x: webPointRef.current.x + move.deltaX,
            y: webPointRef.current.y + move.deltaY,
        }, boundsRef.current);
        webPointRef.current = next;
        webX.set(next.x);
        webY.set(next.y);
    }, [webX, webY]);

    const handleWebDragStart = React.useCallback(() => {
        webProgress.set(snapMotion
            ? 1
            : withTiming(1, { duration: VOICE_MOTION.feedback.durationMs }));
    }, [snapMotion, webProgress]);

    const handleWebDragEnd = React.useCallback(() => {
        webProgress.set(snapMotion
            ? 0
            : withTiming(0, { duration: VOICE_MOTION.exit.durationMs }));
    }, [snapMotion, webProgress]);

    const handleWebRelease = React.useCallback((release: CompanionPointerDragRelease) => {
        const released = webPointRef.current;
        const target = resolveVoiceOrbReleaseTarget({
            projected: {
                x: projectCompanionRelease(released.x, release.velocityX, VOICE_ORB_RELEASE_MOTION),
                y: projectCompanionRelease(released.y, release.velocityY, VOICE_ORB_RELEASE_MOTION),
            },
            bounds: boundsRef.current,
        });
        webPointRef.current = target;
        webX.set(snapMotion
            ? target.x
            : withSpring(
                target.x,
                resolveCompanionReleaseSpringConfig(VOICE_ORB_RELEASE_MOTION, release.velocityX),
            ));
        webY.set(snapMotion
            ? target.y
            : withSpring(
                target.y,
                resolveCompanionReleaseSpringConfig(VOICE_ORB_RELEASE_MOTION, release.velocityY),
            ));
        onDragRelease({ velocityX: release.velocityX, velocityY: release.velocityY });
    }, [onDragRelease, snapMotion, webX, webY]);

    const webDrag = useCompanionPointerDragSession({
        enabled: input.enabled,
        coordinateSpace: 'client',
        selectors: VOICE_ORB_POINTER_DRAG_SELECTORS,
        onDragMove: handleWebMove,
        onDragStart: handleWebDragStart,
        onDragEnd: handleWebDragEnd,
        onDragRelease: handleWebRelease,
    });

    const nativeShouldSuppressPress = pan.shouldSuppressPress;
    const webShouldSuppressPress = webDrag.shouldSuppressPress;
    const shouldSuppressPress = React.useCallback(
        () => (isWeb ? webShouldSuppressPress() : nativeShouldSuppressPress()),
        [isWeb, nativeShouldSuppressPress, webShouldSuppressPress],
    );

    return {
        gesture: pan.gesture,
        translateX: isWeb ? webX : pan.translateX,
        translateY: isWeb ? webY : pan.translateY,
        dragProgress: isWeb ? webProgress : pan.dragProgress,
        dragTargetRef: webDrag.dragTargetRef,
        pointerHandlers: webDrag.pointerHandlers,
        shouldSuppressPress,
    };
}
