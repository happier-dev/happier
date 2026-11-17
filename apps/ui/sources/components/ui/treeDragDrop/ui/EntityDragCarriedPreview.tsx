import {
    resolveHappierCarriedPreviewPlacement,
    type HappierCarriedPreviewPlacement,
    type HappierReleasePreviewIdentity,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useOverlayPortal } from '@/components/ui/popover/OverlayPortal';
import { tryRenderWebPortal, useNativeOverlayPortalNode } from '@/components/ui/popover/portal';
import { DRAG_PREVIEW_Z_INDEX } from '@/components/ui/overlays/overlayLayers';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { installEntityDragCancellation } from '../entityDragCancellation';
import { useEntityDragDropSnapshot } from '../entityDragDropHooks';
import type { EntityDragDropRuntime } from '../entityDragDropTypes';
import { useEntityDropSettledNotices } from './EntityDropSettledFeedback';
import { useEntityDragFeel } from './entityDragFeel';
import { useEntityDropOutcome } from './entityDropOutcome';
import { EntityReleasePreviewCard } from './EntityReleasePreview';
import { keepCarriedPreviewClear } from './carriedPreviewClearance';

/**
 * The carried card (DnD lab E1): rides the pointer below and to the right, names what is carried and,
 * once a place under the pointer answers, what releasing there does — or why it will not.
 *
 * Mounted once for a drag realm; it also installs the realm's cancellation boundary. The semantic leaf (`CarriedCardContent`) wakes only when the
 * owner's verdict changes; only the positioning leaf subscribes to pointer frames, so a carry never
 * re-renders a list. A keyboard or chooser carry has no pointer and draws nothing here: its preview
 * docks under the list instead.
 */
export type EntityDragCarriedPreviewProps = Readonly<{
    runtime: EntityDragDropRuntime;
    /** `touch` draws the phone Organize card across the list at the finger. */
    density?: 'pointer' | 'touch';
    testID?: string;
}>;

const PORTAL_ID = 'entity-drag-carried-preview';
/** The phone card floats this far above the finger, so the finger never hides its words (lab K1h). */
const TOUCH_CARD_LIFT_PX = 76;
const TOUCH_CARD_INSET_PX = 14;

function CarriedCardContent(props: EntityDragCarriedPreviewProps & Readonly<{ side: 'right' | 'left' }>): React.ReactElement | null {
    const snapshot = useEntityDragDropSnapshot(props.runtime);
    const outcome = useEntityDropOutcome(snapshot, snapshot.sourceId ? props.runtime.describeSource(snapshot.sourceId)?.title ?? null : null);
    const returning = snapshot.phase === 'settled' && snapshot.outcome?.status === 'refused';
    // Once released, the source row shows where it landed and that its write is on the way: the floating card
    // is dropped. A pending drop the Home cannot be reached for keeps its quiet words, which the row does not carry.
    const waiting = snapshot.phase === 'pending' && outcome?.tone !== 'pending';
    if ((snapshot.phase !== 'carrying' && !waiting && !returning) || !snapshot.sourceId) return null;
    // Identity comes from the carried source itself, read when the verdict changes.
    const description = props.runtime.describeSource(snapshot.sourceId);
    if (!description) return null;
    const identity: HappierReleasePreviewIdentity = description;
    return (
        <EntityReleasePreviewCard
            identity={identity}
            // The one outcome presenter: a late refusal returns with the words its source line keeps.
            outcome={outcome}
            density={props.density}
            side={props.side}
            testID={props.testID}
        />
    );
}

const MemoCarriedCardContent = React.memo(CarriedCardContent);

function CarriedCardPosition(props: EntityDragCarriedPreviewProps): React.ReactElement | null {
    const { runtime } = props;
    const snapshot = useEntityDragDropSnapshot(runtime);
    const reducedMotion = useReducedMotionPreference();
    const viewport = useWindowDimensions();
    const [size, setSize] = React.useState<Readonly<{ width: number; height: number }>>({ width: 0, height: 0 });
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    }, []);
    const touch = props.density === 'touch';
    // Pointer frames never render this component: it wakes only when a pointer appears or leaves and when
    // the card flips sides. The card's position rides shared values written from the pointer channel.
    const hasPointer = React.useSyncExternalStore(runtime.subscribePointer, () => runtime.getPointer() !== null, () => false);
    const side = React.useSyncExternalStore(runtime.subscribePointer, () => {
        const point = runtime.getPointer();
        return touch || !point ? 'right' : resolveHappierCarriedPreviewPlacement({ pointer: point, size, viewport }).side;
    }, () => 'right' as const);
    const placementRef = React.useRef<HappierCarriedPreviewPlacement>({ left: 0, top: 0, side: 'right' });
    const placeX = useSharedValue(0);
    const placeY = useSharedValue(0);
    const baseLeft = touch ? TOUCH_CARD_INSET_PX : 0;
    const targetId = snapshot.targetId;
    React.useLayoutEffect(() => {
        const place = () => {
            const point = runtime.getPointer();
            if (!point) return;
            const placement = touch
                ? { left: TOUCH_CARD_INSET_PX, top: Math.max(0, point.y - TOUCH_CARD_LIFT_PX), side: 'right' as const }
                : keepCarriedPreviewClear({
                    placement: resolveHappierCarriedPreviewPlacement({ pointer: point, size, viewport }), size, viewport,
                    clear: targetId ? runtime.getTargetClearBounds(targetId) : null,
                });
            placementRef.current = placement;
            placeX.value = placement.left - baseLeft;
            placeY.value = placement.top;
        };
        place();
        return runtime.subscribePointer(place);
    }, [runtime, hasPointer, touch, size, viewport, targetId, baseLeft, placeX, placeY]);
    const returnX = useSharedValue(0);
    const returnY = useSharedValue(0);
    const opacity = useSharedValue(1);
    const returning = snapshot.phase === 'settled' && snapshot.outcome?.status === 'refused' && hasPointer;
    React.useEffect(() => {
        cancelAnimation(returnX);
        cancelAnimation(returnY);
        cancelAnimation(opacity);
        if (!returning || !snapshot.sourceId) {
            returnX.value = 0;
            returnY.value = 0;
            opacity.value = 1;
            return;
        }
        const finish = () => {
            // A new gesture can interrupt this return. Its carry must survive the old completion.
            if (props.runtime.getSnapshot() === snapshot) props.runtime.cancel('feedback-finished');
        };
        const bounds = props.runtime.getSourceBounds(snapshot.sourceId);
        if (reducedMotion || !bounds) {
            opacity.value = withTiming(0, { duration: reanimatedMotionTokens.durationMs.fast }, (finished) => {
                'worklet';
                if (finished) scheduleOnRN(finish);
            });
        } else {
            returnX.value = withSpring(bounds.x - placementRef.current.left, reanimatedMotionTokens.spring.travel);
            returnY.value = withSpring(bounds.y - placementRef.current.top, reanimatedMotionTokens.spring.travel, (finished) => {
                'worklet';
                if (finished) scheduleOnRN(finish);
            });
        }
        return () => {
            cancelAnimation(returnX);
            cancelAnimation(returnY);
            cancelAnimation(opacity);
        };
    }, [opacity, props.runtime, reducedMotion, returnX, returnY, returning, snapshot]);
    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: placeX.value + returnX.value }, { translateY: placeY.value + returnY.value }],
        opacity: opacity.value,
    }));
    if (!hasPointer) return null;
    return (
        <View
            pointerEvents="none"
            onLayout={onLayout}
            style={[
                {
                    position: Platform.OS === 'web' ? ('fixed' as 'absolute') : 'absolute',
                    left: baseLeft,
                    top: 0,
                    zIndex: DRAG_PREVIEW_Z_INDEX,
                    // Hidden until measured once, so the first frame never lands on the wrong side.
                    opacity: touch || size.width > 0 ? 1 : 0,
                },
                touch ? { right: TOUCH_CARD_INSET_PX } : null,
            ]}
        >
            <Animated.View style={animatedStyle}>
                <MemoCarriedCardContent {...props} side={side} />
            </Animated.View>
        </View>
    );
}

export function EntityDragCarriedPreview(props: EntityDragCarriedPreviewProps): React.ReactElement | null {
    const overlayPortal = useOverlayPortal();
    // The realm keeps late outcomes for its source rows and owns the carry's feel (haptics, cursor).
    useEntityDropSettledNotices(props.runtime);
    useEntityDragFeel(props.runtime);
    // The feedback host owns the realm's one cancellation boundary (Escape, lost capture, leaving the
    // window, blur), so a carry never outlives the gesture that started it.
    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        return installEntityDragCancellation(props.runtime, window);
    }, [props.runtime]);
    // Native geometry is asynchronous. The realm batches its matching targets
    // and admits once after they answer, rather than once per measured target.
    // Web hit testing reads current DOM geometry synchronously.
    React.useEffect(() => {
        if (Platform.OS === 'web') return;
        return props.runtime.subscribePointer(() => { void props.runtime.refreshMeasurements(); });
    }, [props.runtime]);
    const content = React.useMemo(() => <CarriedCardPosition {...props} />, [props]);
    useNativeOverlayPortalNode({
        overlayPortal,
        portalId: PORTAL_ID,
        enabled: Platform.OS !== 'web',
        content,
    });
    if (Platform.OS !== 'web') return null;
    return tryRenderWebPortal({
        shouldPortalWeb: true,
        portalTargetOnWeb: 'body',
        modalPortalTarget: null,
        getBoundaryDomElement: () => null,
        content,
    }) as React.ReactElement | null ?? content;
}
