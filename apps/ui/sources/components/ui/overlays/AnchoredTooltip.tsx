import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Popover } from '@/components/ui/popover/Popover';
import { Text } from '@/components/ui/text/Text';
import { resolveThemeSurfaceChromeStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { resolveThemeRaisedEdge } from '@/components/ui/surfaces/themeRaisedEdge';
import { SurfaceRim } from '@/components/ui/surfaces/SurfaceRim';
import { surfaceUsesRim } from '@/components/ui/surfaces/surfaceEdgeTreatment';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';

const TOOLTIP_RADIUS_PX = 6;
/** Keeps a tooltip off the window's edge when it is clamped there. */
const TOOLTIP_EDGE_PADDING_PX = 8;
/** `edgePadding` insets the boundary; the tooltip's own box carries no extra padding. */
const TOOLTIP_CONTAINER_STYLE = { paddingHorizontal: 0, paddingVertical: 0 } as const;
/** The side a tooltip asks for must hold about three lines, or it opens on the opposite side. */
const TOOLTIP_MAX_HEIGHT_PX = 72;

/**
 * Mounted only while its trigger is hovered or keyboard-focused. The Popover owner places it: sized
 * to its label, centred on the anchor's measured rect with one gap, flipped to the opposite side when
 * its own side has no room and clamped inside the window. The window, not the enclosing boundary, is
 * its limit, so a tooltip in the sidebar is never pushed off its button by the sidebar's edge.
 */
export default function AnchoredTooltip(props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    label: string;
    content?: React.ReactNode;
    testID?: string;
    placement?: 'top' | 'bottom' | 'left' | 'right';
}>) {
    return (
        <Popover
            open
            anchorRef={props.anchorRef}
            backdrop={false}
            boundaryRef={null}
            portal={{ web: true, matchAnchorWidth: false, anchorAlign: 'center', sizeToContent: true }}
            placement={props.placement ?? 'bottom'}
            flip
            gap={6}
            edgePadding={TOOLTIP_EDGE_PADDING_PX}
            containerStyle={TOOLTIP_CONTAINER_STYLE}
            minWidth={0}
            maxWidthCap={240}
            maxHeightCap={TOOLTIP_MAX_HEIGHT_PX}
        >
            {() => (
                <AnchoredTooltipBubble {...props} />
            )}
        </Popover>
    );
}

/** The bubble's semantic body, independent of the Popover's placement lifecycle. */
export function AnchoredTooltipBubble(props: Readonly<{ label: string; content?: React.ReactNode; testID?: string }>) {
    return <GlassSurface surfaceGroup="floating" role="tooltip" testID={props.testID} style={styles.bubble}>
        {props.content ?? <Text style={styles.label}>{props.label}</Text>}
        <SurfaceRim role="floating" radius={TOOLTIP_RADIUS_PX} border="modal" />
    </GlassSurface>;
}

// A tooltip is the smallest floating surface: the shared surface hairline, its raised edge and the
// tooltip step of the elevation ladder.
const styles = StyleSheet.create((theme) => ({
    bubble: {
        pointerEvents: 'none',
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: TOOLTIP_RADIUS_PX,
        backgroundColor: theme.colors.surface.elevated,
        ...resolveThemeSurfaceChromeStyle({
            borderColor: theme.colors.border.modal,
            edge: resolveThemeRaisedEdge(theme, 'modal'),
            rim: surfaceUsesRim('floating', theme.dark),
            shadowStyle: shadowLevelStyle(theme.colors.shadowLevels[2]),
        }),
    },
    label: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.primary,
    },
}));
