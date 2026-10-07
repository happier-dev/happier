import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_WIDGET_FRAME_METRICS, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { getWidgetSizeFootprintV1, type WidgetSizeV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { CARD_GRID } from '@/components/ui/cardGrid/cardGridMetrics';
import { PAGE_COLUMN_MAX_WIDTH_PX } from '@/components/ui/layout/contentWidthMode';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The width of the surface the widget will stand in: the page column a grid surface lays its cards
 * across (Home, a WorkBoard, a plugin area), less its sheet inset. The stage draws the card at this
 * width's column geometry, then scales the whole surface once, so every size compares honestly.
 */
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
    caption: string;
    /** The body is reading this viewer's live data (the caption carries the live dot). */
    live?: boolean;
    accessibilityLabel: string;
    testID: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const styles = stylesheet;
    const [room, setRoom] = React.useState(0);
    const [height, setHeight] = React.useState(0);
    const onRoomLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setRoom((previous) => (previous === next ? previous : next));
    }, []);
    const onCardLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.height);
        setHeight((previous) => (previous === next ? previous : next));
    }, []);
    const footprint = props.surface && props.size ? getWidgetSizeFootprintV1(props.surface, props.size) : undefined;
    const surfaceWidth = footprint ? referenceSurfaceWidthPx() : Math.max(room, 1);
    const scale = room > 0 ? Math.min(1, room / surfaceWidth) : 1;
    const gap = CARD_GRID.gapPx;
    const column = footprint ? (surfaceWidth - gap * (footprint.columns - 1)) / footprint.columns : surfaceWidth;
    const cardWidth = footprint ? column * footprint.columnSpan + gap * (footprint.columnSpan - 1) : surfaceWidth;
    const rest = footprint ? surfaceWidth - cardWidth - gap : 0;
    return (
        <View style={styles.stage} testID={props.testID}>
            <View style={styles.captionRow}>
                {props.live ? <View style={styles.liveDot} testID={`${props.testID}.live`} /> : null}
                <Text style={styles.caption} numberOfLines={1}>{props.caption}</Text>
            </View>
            <View style={styles.room} onLayout={onRoomLayout}>
                {/* Mounted at once (the selected widget is the preview); shown once the room is measured. */}
                <View style={[styles.frame, { width: surfaceWidth * scale, height: height * scale, opacity: room > 0 ? 1 : 0 }]}>
                    <View
                        style={[styles.surface, { width: surfaceWidth, transform: [{ scale }] }]}
                        onLayout={onCardLayout}
                        pointerEvents="none"
                        accessible
                        accessibilityRole="image"
                        accessibilityLabel={props.accessibilityLabel}
                    >
                        <View style={{ width: cardWidth }}>{props.children}</View>
                        {rest > 0 ? <View testID={`${props.testID}.ghost`} style={[styles.ghost, { width: rest }]} /> : null}
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
    frame: { overflow: 'visible' },
    // Laid out at the surface's own width, then scaled from its top-left corner into the frame.
    surface: { position: 'absolute', left: 0, top: 0, flexDirection: 'row', alignItems: 'stretch', gap: CARD_GRID.gapPx, transformOrigin: 'top left' },
    // The cells beside the card: where the rest of the surface would be, never content.
    ghost: { borderRadius: HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx, borderWidth: 1, borderStyle: 'dashed', borderColor: theme.colors.border.default },
}));
