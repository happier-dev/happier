import {
    resolveHappierCarriedPreviewPlacement,
    type HappierReleaseOutcome,
    type HappierReleasePreviewIdentity,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';

import { useOverlayPortal } from '@/components/ui/popover/OverlayPortal';
import { POPOVER_PORTAL_Z_INDEX, tryRenderWebPortal, useNativeOverlayPortalNode } from '@/components/ui/popover/portal';

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
    if ((snapshot.phase !== 'carrying' && snapshot.phase !== 'pending') || !snapshot.sourceId) return null;
    // Identity comes from the carried source itself, read when the verdict changes.
    const description = props.runtime.describeSource(snapshot.sourceId);
    if (!description) return null;
    const identity: HappierReleasePreviewIdentity = description;
    return (
        <EntityReleasePreviewCard
            identity={identity}
            outcome={props.describeOutcome(snapshot)}
            density={props.density}
            side={props.side}
            testID={props.testID}
        />
    );
}

const MemoCarriedCardContent = React.memo(CarriedCardContent);

function CarriedCardPosition(props: EntityDragCarriedPreviewProps): React.ReactElement | null {
    const pointer = useEntityDragPointer(props.runtime);
    const viewport = useWindowDimensions();
    const [size, setSize] = React.useState<Readonly<{ width: number; height: number }>>({ width: 0, height: 0 });
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    }, []);
    if (!pointer) return null;
    const touch = props.density === 'touch';
    const placement = touch
        ? { left: TOUCH_CARD_INSET_PX, top: Math.max(0, pointer.y - TOUCH_CARD_LIFT_PX), side: 'right' as const }
        : resolveHappierCarriedPreviewPlacement({ pointer, size, viewport });
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
            <MemoCarriedCardContent {...props} side={placement.side} />
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
