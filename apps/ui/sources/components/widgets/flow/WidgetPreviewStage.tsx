import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { getWidgetSizeFootprintV1, type WidgetSizeV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { CARD_GRID } from '@/components/ui/cardGrid/cardGridMetrics';
import { EmptySlot } from '@/components/ui/empty/EmptySlot';
import { PAGE_COLUMN_MAX_WIDTH_PX } from '@/components/ui/layout/contentWidthMode';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Typography } from '@/constants/Typography';

/**
 * The width of the surface the widget will stand in: the page column a grid surface lays its cards
 * across (Home, a WorkBoard, a plugin area), less its sheet inset. The stage draws the card at this
 * width's column geometry, then scales the whole surface once, so every size compares honestly.
 */
/** A footprint's width on a surface of the given width, with the grid's gaps. */
function cardWidthOf(footprint: Readonly<{ columns: number; columnSpan: number }>, surfaceWidth: number): number {
    const column = (surfaceWidth - CARD_GRID.gapPx * (footprint.columns - 1)) / footprint.columns;
    return column * footprint.columnSpan + CARD_GRID.gapPx * (footprint.columnSpan - 1);
}

function referenceSurfaceWidthPx(): number {
    return PAGE_COLUMN_MAX_WIDTH_PX.reading - 2 * resolveItemGroupContentHorizontalInsetPx();
}

/**
 * The Add pane's stage (lab `widget-add` wsplit A): the real card at its real size on this surface,
 * standing in the surface's own columns, with the empty cells beside it as quiet outlines. One scale
 * per surface (never per size), so Small, Medium and Wide read as the footprints they are. A surface
 * without sizes (the Companion, a Project aside) shows the card at the stage's width.
 *
 * The card is inert and announced as one image; the footer line, not the card, speaks.
 */
export function WidgetPreviewStage(props: Readonly<{
    surface: WidgetSurfaceRefV1['owner']['kind'] | null;
    size: WidgetSizeV1 | undefined;
    /** What is staged is not a sized widget (a group at Half or Full): its columns on the surface. */
    footprint?: Readonly<{ columns: number; columnSpan: number }>;
    /** Show only what is staged, centred, at its width on the surface; no surrounding cells (lab wgsaved A). */
    alone?: boolean;
    caption: string;
    /** The body is reading this viewer's live data (the caption carries the live dot). */
    live?: boolean;
    accessibilityLabel: string;
    testID: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const styles = stylesheet;
    const [room, setRoom] = React.useState(0);
    const [roomHeight, setRoomHeight] = React.useState(0);
    const [height, setHeight] = React.useState(0);
    const onRoomLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.width);
        const nextHeight = Math.round(event.nativeEvent.layout.height);
        setRoom((previous) => (previous === next ? previous : next));
        setRoomHeight((previous) => (previous === nextHeight ? previous : nextHeight));
    }, []);
    const onCardLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.height);
        setHeight((previous) => (previous === next ? previous : next));
    }, []);
    const footprint = props.footprint ?? (props.surface && props.size ? getWidgetSizeFootprintV1(props.surface, props.size) : undefined);
    const surfaceWidth = footprint ? referenceSurfaceWidthPx() : Math.max(room, 1);
    // The whole surface fits the room both ways: a tall one (a group of several widgets) is shown
    // smaller, never cut at the stage's foot.
    const laidWidth = props.alone && footprint ? cardWidthOf(footprint, referenceSurfaceWidthPx()) : surfaceWidth;
    const scale = room > 0 ? Math.min(1, room / laidWidth, height > 0 && roomHeight > 0 ? roomHeight / height : 1) : 1;
    const gap = CARD_GRID.gapPx;
    const column = footprint ? (surfaceWidth - gap * (footprint.columns - 1)) / footprint.columns : surfaceWidth;
    const cardWidth = footprint ? column * footprint.columnSpan + gap * (footprint.columnSpan - 1) : surfaceWidth;
    const rest = footprint && !props.alone ? surfaceWidth - cardWidth - gap : 0;
    // Choosing another size morphs the one card to its new footprint and fades the body in inside it
    // (lab `widget-add` KM): no second card, and only the chosen body is mounted. The first layout and
    // a re-measured room place it at once; reduced motion keeps the fade and drops the travel.
    const reducedMotion = useReducedMotionPreference();
    const chosen = `${props.size ?? ''}:${footprint?.columnSpan ?? ''}`;
    const morph = React.useRef({ chosen, cardWidth });
    const animatedWidth = useSharedValue(cardWidth);
    const bodyOpacity = useSharedValue(1);
    React.useEffect(() => {
        const previous = morph.current;
        morph.current = { chosen, cardWidth };
        if (previous.chosen === chosen) {
            animatedWidth.value = cardWidth;
            return;
        }
        animatedWidth.value = reducedMotion ? cardWidth
            : withTiming(cardWidth, { duration: reanimatedMotionTokens.durationMs.base, easing: reanimatedMotionTokens.easing.standard });
        // The frame stays: the card dips rather than vanishing while its new body arrives.
        bodyOpacity.value = motionTokens.press.opacitySubtle;
        bodyOpacity.value = withTiming(1, { duration: reanimatedMotionTokens.durationMs[reducedMotion ? 'fast' : 'base'], easing: reanimatedMotionTokens.easing.standard });
    }, [animatedWidth, bodyOpacity, cardWidth, chosen, reducedMotion]);
    const cardStyle = useAnimatedStyle(() => ({ width: animatedWidth.value, opacity: bodyOpacity.value }));
    return (
        <View style={styles.stage} testID={props.testID}>
            <View style={styles.captionRow}>
                {props.live ? <View style={styles.liveDot} testID={`${props.testID}.live`} /> : null}
                <Text style={styles.caption} numberOfLines={1}>{props.caption}</Text>
            </View>
            <View style={styles.room} onLayout={onRoomLayout}>
                {/* Mounted at once (the selected widget is the preview); shown once the room is measured. */}
                <View style={[styles.frame, { width: laidWidth * scale, height: height * scale, opacity: room > 0 ? 1 : 0 }]}>
                    <View
                        style={[styles.surface, { width: laidWidth, transform: [{ scale }] }]}
                        onLayout={onCardLayout}
                        pointerEvents="none"
                        accessible
                        accessibilityRole="image"
                        accessibilityLabel={props.accessibilityLabel}
                    >
                        <Animated.View style={cardStyle}>{props.children}</Animated.View>
                        {rest > 0 ? <EmptySlot testID={`${props.testID}.ghost`} style={{ width: rest, flexGrow: 0 }} /> : null}
                    </View>
                </View>
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    stage: { flex: 1, minHeight: 160, gap: 8 },
    captionRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    caption: { ...Typography.default('semiBold'), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary },
    // Live is the one state the caption shows in colour.
    liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.state.success.foreground },
    room: { flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    // Out of flow, so the room keeps the pane's height and the surface is scaled into it.
    frame: { position: 'absolute', overflow: 'visible' },
    // Laid out at the surface's own width, then scaled from its top-left corner into the frame.
    surface: { position: 'absolute', left: 0, top: 0, flexDirection: 'row', alignItems: 'stretch', gap: CARD_GRID.gapPx, transformOrigin: 'top left' },
}));
