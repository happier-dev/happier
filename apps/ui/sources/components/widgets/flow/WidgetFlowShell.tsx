import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { slideTransitionTokens } from '@/components/ui/motion/slideTransitionTokens';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { WidgetFlowHeightBoundContext } from '@/components/widgets/flow/WidgetFlowPanel';
import { Popover } from '@/components/ui/popover';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { BaseModal } from '@/modal/components/BaseModal';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import { useDeviceType } from '@/utils/platform/responsive';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { HAPPIER_RADIUS_V1 } from '@happier-dev/plugin-ui/environment';

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
/** The grabber and its spacing above a sheet's content. */
const SHEET_GRABBER_ROOM_PX = 32;

/** The gap the flow keeps from the window's edges; the flow's own width sits inside it. */
const EDGE_PADDING_PX = 8;

/**
 * The one floating surface every widget flow uses on desktop: Edit inputs, About, Save as your
 * widget and Post a snapshot, anchored to the control that opened it: it starts at the ⋯ it came from
 * and slides back inside the window, so it stays over the content. Each flow keeps one width for its whole life.
 */
export function AnchoredWidgetShell(props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    placement: 'top' | 'bottom' | undefined;
    width: number;
    onRequestClose: () => void;
    children: React.ReactNode;
}>): React.ReactElement {
    // A pane narrower than the flow cannot hold it beside its trigger: the flow then takes the pane's whole width, edge to
    // edge, so it covers what it was opened from instead of leaving a strip of it showing.
    const [cramped, setCramped] = React.useState(false);
    return (
        <Popover
            open
            anchorRef={props.anchorRef}
            placement={props.placement ?? 'bottom'}
            gap={8}
            maxHeightCap={MAX_HEIGHT_PX}
            // A designed flow keeps its full size and slides inside the window rather than being
            // squeezed into the room below a mid-page ⋯, which scrolled its footer out of view.
            fit="shift"
            maxWidthCap={props.width + 2 * EDGE_PADDING_PX}
            edgePadding={{ vertical: EDGE_PADDING_PX, horizontal: EDGE_PADDING_PX }}
            // Opens from the ⋯ toward the content and slides back inside the window, so a card in the
            // left column never pushes its flow over the navigation (QA-V F11; lab d2edit-SET).
            portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'start', ...(cramped ? { topBottomLayout: 'boundary' as const } : {}) }}
            onRequestClose={props.onRequestClose}
            backdrop={{ effect: 'none', closeOnPan: true }}
        >
            {({ maxHeight, maxWidth }) => (
                // A definite width, capped by the room the Popover reports, which is already inside its own edge padding.
                <View style={{ alignSelf: 'flex-start', width: Math.min(props.width, maxWidth) }}>
                    <CrampedReport cramped={maxWidth < props.width} onChange={setCramped} />
                    {/* The flow scrolls its own body inside this room, so its header and footer stay put. */}
                    <FloatingOverlay maxHeight={maxHeight} scrollEnabled={false} keyboardShouldPersistTaps="always">
                        <WidgetFlowHeightBoundContext.Provider value={maxHeight}>
                            {props.children}
                        </WidgetFlowHeightBoundContext.Provider>
                    </FloatingOverlay>
                </View>
            )}
        </Popover>
    );
}

/** Reports whether the room the Popover found is narrower than the flow wants; the shell answers by filling that room. */
function CrampedReport(props: Readonly<{ cramped: boolean; onChange: (cramped: boolean) => void }>): null {
    const { cramped, onChange } = props;
    React.useEffect(() => { onChange(cramped); }, [cramped, onChange]);
    return null;
}

/** A phone sheet's one dismiss (lab wgphone Mp, wadd Ap): "Done", as the navigation bar would draw it. */
export function WidgetSheetDone(props: Readonly<{ onPress: () => void; testID?: string }>): React.ReactElement {
    return (
        <HappierPressable testID={props.testID} accessibilityRole="button" accessibilityLabel={t('common.done')}
            onPress={props.onPress} style={sheetStyles.done}>
            <Text style={sheetStyles.doneLabel}>{t('common.done')}</Text>
        </HappierPressable>
    );
}

/**
 * The same flows as the app's bottom sheet on a phone, in thumb reach. A flow that has its own header
 * draws its title itself; a sheet that is only a list of choices (a group's ⋯) passes `heading`, and
 * the shell names the object once — its name, one quiet fact about it — with Done.
 */
export function WidgetSheetShell(props: Readonly<{
    title: string;
    /** Draws the sheet's own header: the title, this quiet fact beside it, and Done. */
    heading?: Readonly<{ meta?: string; doneTestID?: string }>;
    onRequestClose: () => void;
    testID: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const insets = useChromeSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    // A flow in the sheet keeps its header and footer in reach and scrolls only its body: the room is the sheet's own
    // ceiling less the safe area and the grabber, never the length of the list inside it.
    const flowMaxHeight = Math.max(0, Math.floor(windowHeight * SHEET_MAX_HEIGHT_RATIO) - insets.bottom - SHEET_GRABBER_ROOM_PX);
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
                bodyScroll="auto"
                sheetBottomInset={insets.bottom}
                dimensions={{ maxHeightRatio: SHEET_MAX_HEIGHT_RATIO }}
                testID={props.testID}
            >
                {props.heading ? (
                    <View style={sheetStyles.heading}>
                        <Text style={sheetStyles.headingTitle} accessibilityRole="header" numberOfLines={1}>{props.title}</Text>
                        {props.heading.meta ? <Text style={sheetStyles.headingMeta} numberOfLines={1}>{props.heading.meta}</Text> : null}
                        <View style={sheetStyles.headingGrow} />
                        <WidgetSheetDone onPress={props.onRequestClose} testID={props.heading.doneTestID ?? `${props.testID}.done`} />
                    </View>
                ) : null}
                <WidgetFlowHeightBoundContext.Provider value={flowMaxHeight}>
                    {props.children}
                </WidgetFlowHeightBoundContext.Provider>
            </ModalCardFrame>
        </BaseModal>
    );
}

/**
 * The ⋯ menu of a widget and of a group on a phone: the same bottom sheet, naming the object once with
 * Done (lab wgmenu Cp, wgphone Mp). It is `undefined` on a wider window, where the menu stays anchored.
 * Pass it as `renderOverflowSurface`.
 */
export function useWidgetMenuSurface(input: Readonly<{ title: string; meta?: string; testID: string }>) {
    const phone = useDeviceType() === 'phone';
    const { title, meta, testID } = input;
    return React.useMemo(() => phone
        ? ({ children, onRequestClose }: Readonly<{ children: React.ReactNode; onRequestClose: () => void }>) => (
            <WidgetSheetShell title={title} heading={{ ...(meta === undefined ? {} : { meta }), doneTestID: `${testID}.done` }}
                onRequestClose={onRequestClose} testID={`${testID}.sheet`}>
                {children}
            </WidgetSheetShell>
        )
        : undefined, [phone, title, meta, testID]);
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

const sheetStyles = StyleSheet.create((theme) => ({
    // The header's text starts on the menu rows' text column (a row's own padding).
    heading: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: theme.space.s8,
        paddingLeft: MENU_ROW_METRICS.paddingHorizontalPx,
        paddingRight: MENU_ROW_METRICS.paddingHorizontalPx - 6,
    },
    headingTitle: { ...Typography.default('semiBold'), ...happierPageTextMetrics('sectionTitle'), color: theme.colors.text.primary, flexShrink: 1 },
    headingMeta: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary, flexShrink: 1 },
    headingGrow: { flex: 1 },
    done: { paddingHorizontal: theme.space.s6, paddingVertical: theme.space.s8, borderRadius: HAPPIER_RADIUS_V1.sm },
    doneLabel: { ...Typography.default('semiBold'), ...happierPageTextMetrics('rowTitle'), color: theme.colors.text.link },
}));
