import * as React from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { slideTransitionTokens } from '@/components/ui/motion/slideTransitionTokens';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { BaseModal } from '@/modal/components/BaseModal';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import { useDeviceType } from '@/utils/platform/responsive';

/**
 * The widget flows' widths: an Edit inputs / repair step holds its inputs column and the preview
 * beside it, and About, Save as your widget and Post a snapshot read as one column. The Add surface
 * has its own fixed composition (`WIDGET_ADD_SURFACE_PX`).
 */
export const WIDGET_FLOW_WIDTH_PX = Object.freeze({
    setup: 800,
    panel: 560,
});
const MAX_HEIGHT_PX = 640;
/** The sheet leaves the top of the screen visible, so the surface it changes stays in view. */
const SHEET_MAX_HEIGHT_RATIO = 0.9;

/**
 * The one floating surface every widget flow uses on desktop: Edit inputs, About, Save as your
 * widget and Post a snapshot, anchored to the control that opened it with its trailing edge on the
 * anchor's (the ⋯ it came from). Each flow keeps one width for its whole life.
 */
export function AnchoredWidgetShell(props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    placement: 'top' | 'bottom' | undefined;
    width: number;
    onRequestClose: () => void;
    children: React.ReactNode;
}>): React.ReactElement {
    return (
        <Popover
            open
            anchorRef={props.anchorRef}
            placement={props.placement ?? 'bottom'}
            gap={8}
            maxHeightCap={MAX_HEIGHT_PX}
            maxWidthCap={props.width}
            edgePadding={{ vertical: 8, horizontal: 8 }}
            portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
            onRequestClose={props.onRequestClose}
            backdrop={{ effect: 'none', closeOnPan: true }}
        >
            {({ maxHeight, maxWidth }) => (
                // A definite width, capped by the room the Popover found.
                <View style={{ alignSelf: 'flex-end', width: Math.min(props.width, maxWidth) }}>
                    <FloatingOverlay
                        maxHeight={maxHeight}
                        keyboardShouldPersistTaps="always"
                        edgeFades={{ top: true, bottom: true, size: 24 }}
                        edgeIndicators={true}
                    >
                        {props.children}
                    </FloatingOverlay>
                </View>
            )}
        </Popover>
    );
}

/** The same flows as the app's bottom sheet on a phone, in thumb reach; the flow draws its own title. */
export function WidgetSheetShell(props: Readonly<{ title: string; onRequestClose: () => void; testID: string; children: React.ReactNode }>): React.ReactElement {
    const insets = useChromeSafeAreaInsets();
    return (
        <BaseModal
            visible
            placement="bottom"
            showBackdrop
            accessibilityLabel={props.title}
            onClose={props.onRequestClose}
        >
            <ModalCardFrame
                header="none"
                title={props.title}
                presentation="sheet"
                sheetBottomInset={insets.bottom}
                dimensions={{ maxHeightRatio: SHEET_MAX_HEIGHT_RATIO }}
                testID={props.testID}
            >
                {props.children}
            </ModalCardFrame>
        </BaseModal>
    );
}

/**
 * One widget flow opened from a card (About, Save as your widget, Post a snapshot, Edit inputs):
 * anchored to the card's ⋯ on desktop, a bottom sheet on a phone. Mounted only while open.
 */
export function WidgetFlowShell(props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    title: string;
    width?: number;
    placement?: 'top' | 'bottom';
    onRequestClose: () => void;
    testID: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const phone = useDeviceType() === 'phone';
    return phone ? (
        <WidgetSheetShell title={props.title} onRequestClose={props.onRequestClose} testID={`${props.testID}.sheet`}>{props.children}</WidgetSheetShell>
    ) : (
        <AnchoredWidgetShell anchorRef={props.anchorRef} placement={props.placement} width={props.width ?? WIDGET_FLOW_WIDTH_PX.panel}
            onRequestClose={props.onRequestClose}>
            {props.children}
        </AnchoredWidgetShell>
    );
}

/**
 * One step of a flow arriving (the narrow Add surface and phones: the list pushes the selected
 * widget's pane): it enters from the trailing edge going forward and from the leading edge coming
 * Back, on the routine step timing. Only the arriving step is mounted, so a pane leaving never keeps
 * its live preview reading. Reduced motion: a short cross-fade.
 */
export function WidgetFlowStep(props: Readonly<{ direction: 'forward' | 'backward' | 'none'; fill?: boolean; children: React.ReactNode }>): React.ReactElement {
    const reducedMotion = useReducedMotionPreference();
    const travel = props.direction === 'none' || reducedMotion ? 0
        : props.direction === 'forward' ? STEP_TRAVEL_PX : -STEP_TRAVEL_PX;
    const animate = props.direction !== 'none';
    const opacity = useSharedValue(animate ? 0 : 1);
    const offset = useSharedValue(travel);
    React.useEffect(() => {
        if (!animate) return;
        const timing = {
            duration: reducedMotion ? reanimatedMotionTokens.durationMs.fast : reanimatedMotionTokens.durationMs.base,
            easing: reanimatedMotionTokens.easing.standard,
        };
        // Enter once: the values only ever move to rest, so a later run never replays it.
        opacity.value = withTiming(1, timing);
        offset.value = withTiming(0, timing);
    }, [animate, offset, opacity, reducedMotion]);
    const style = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateX: offset.value }] }));
    return <Animated.View style={[props.fill ? FILL : null, style]}>{props.children}</Animated.View>;
}

const FILL = { flex: 1, minHeight: 0 } as const;

/** The routine step's travel: enough to read as a push, never a slide-show. */
const STEP_TRAVEL_PX = slideTransitionTokens.routine.timed.translatePx;
