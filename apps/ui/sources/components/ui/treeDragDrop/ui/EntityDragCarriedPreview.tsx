import {
    resolveHappierCarriedPreviewPlacement,
    type HappierReleaseOutcome,
    type HappierReleasePreviewIdentity,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useOverlayPortal } from '@/components/ui/popover/OverlayPortal';
import { POPOVER_PORTAL_Z_INDEX, tryRenderWebPortal, useNativeOverlayPortalNode } from '@/components/ui/popover/portal';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { installEntityDragCancellation } from '../entityDragCancellation';
import { useEntityDragDropSnapshot, useEntityDragPointer } from '../entityDragDropHooks';
import type { EntityDragDropRuntime, EntityDragDropSnapshot } from '../entityDragDropTypes';
import { EntityReleasePreviewCard } from './EntityReleasePreview';

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
    /** The owner's verdict in words; `null` while nothing under the pointer takes the item. */
    describeOutcome: (snapshot: EntityDragDropSnapshot) => HappierReleaseOutcome | null;
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
    const returning = snapshot.phase === 'settled' && snapshot.outcome?.status === 'refused';
    if ((snapshot.phase !== 'carrying' && snapshot.phase !== 'pending' && !returning) || !snapshot.sourceId) return null;
    // Identity comes from the carried source itself, read when the verdict changes.
    const description = props.runtime.describeSource(snapshot.sourceId);
    if (!description) return null;
    const identity: HappierReleasePreviewIdentity = description;
    return (
        <EntityReleasePreviewCard
            identity={identity}
            outcome={snapshot.outcome?.status === 'refused' ? {
                tone: 'refused', title: t('entityDragDrop.preview.cantMoveHere'), detail: snapshot.outcome.reason.message,
            } : props.describeOutcome(snapshot)}
            density={props.density}
            side={props.side}
            testID={props.testID}
        />
    );
}

const MemoCarriedCardContent = React.memo(CarriedCardContent);

function CarriedCardPosition(props: EntityDragCarriedPreviewProps): React.ReactElement | null {
    const pointer = useEntityDragPointer(props.runtime);
    const snapshot = useEntityDragDropSnapshot(props.runtime);
    const reducedMotion = useReducedMotionPreference();
    const viewport = useWindowDimensions();
    const [size, setSize] = React.useState<Readonly<{ width: number; height: number }>>({ width: 0, height: 0 });
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    }, []);
    const touch = props.density === 'touch';
    const point = pointer ?? { x: 0, y: 0 };
    const placement = touch
        ? { left: TOUCH_CARD_INSET_PX, top: Math.max(0, point.y - TOUCH_CARD_LIFT_PX), side: 'right' as const }
        : resolveHappierCarriedPreviewPlacement({ pointer: point, size, viewport });
    const placementRef = React.useRef(placement);
    placementRef.current = placement;
    const returnX = useSharedValue(0);
    const returnY = useSharedValue(0);
    const opacity = useSharedValue(1);
    const returning = snapshot.phase === 'settled' && snapshot.outcome?.status === 'refused' && pointer !== null;
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
        transform: [{ translateX: returnX.value }, { translateY: returnY.value }],
        opacity: opacity.value,
    }));
    if (!pointer) return null;
    return (
        <View
            pointerEvents="none"
            onLayout={onLayout}
            style={[
                {
                    position: Platform.OS === 'web' ? ('fixed' as 'absolute') : 'absolute',
                    left: placement.left,
                    top: placement.top,
                    zIndex: POPOVER_PORTAL_Z_INDEX,
                    // Hidden until measured once, so the first frame never lands on the wrong side.
                    opacity: touch || size.width > 0 ? 1 : 0,
                },
                touch ? { right: TOUCH_CARD_INSET_PX } : null,
            ]}
        >
            <Animated.View style={animatedStyle}>
                <MemoCarriedCardContent {...props} side={placement.side} />
            </Animated.View>
        </View>
    );
}

export function EntityDragCarriedPreview(props: EntityDragCarriedPreviewProps): React.ReactElement | null {
    const overlayPortal = useOverlayPortal();
    // The feedback host owns the realm's one cancellation boundary (Escape, lost capture, leaving the
    // window, blur), so a carry never outlives the gesture that started it.
    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        return installEntityDragCancellation(props.runtime, window);
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
