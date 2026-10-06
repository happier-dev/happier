import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_MOTION_V1 } from '@happier-dev/plugin-ui/presentation';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { SplitCanvasDirection, SplitCanvasDropTarget } from '../model/splitCanvasTypes';

/**
 * The pane zone (DnD lab C2/C2s). Geometry only: what releasing does is said on the carried card.
 *
 * - Centre: the pane takes a soft outline, with a short mark at each edge the pane can still split.
 *   A pane too narrow to split shows no edge marks; its whole body is the centre.
 * - Edge: the zone covers the part of the pane the new pane will take (a split starts even), over a
 *   frosted veil, so the person sees the real size before letting go.
 *
 * The zone sits inset from the pane edge so it never reads as the pane's own border.
 */

/** A split starts even (`splitLeaf` ratio): the new pane takes half of the pane it splits. */
const NEW_PANE_SHARE = '50%';
const ZONE_INSET_PX = 8;
const ZONE_RADIUS_PX = 12;
const EDGE_MARK = Object.freeze({ thicknessPx: 4, lengthPx: 36, insetPx: 10 });

function zoneFrame(placement: SplitCanvasDropTarget['placement']): ViewStyle {
    const inset = ZONE_INSET_PX;
    switch (placement) {
        case 'left': return { top: inset, bottom: inset, left: inset, right: NEW_PANE_SHARE };
        case 'right': return { top: inset, bottom: inset, left: NEW_PANE_SHARE, right: inset };
        case 'up': return { top: inset, bottom: NEW_PANE_SHARE, left: inset, right: inset };
        case 'down': return { top: NEW_PANE_SHARE, bottom: inset, left: inset, right: inset };
        case 'center':
        default: return { top: inset, bottom: inset, left: inset, right: inset };
    }
}

function edgeMarkFrame(direction: SplitCanvasDirection): ViewStyle {
    const { thicknessPx, lengthPx, insetPx } = EDGE_MARK;
    const vertical = direction === 'left' || direction === 'right';
    const along = { [vertical ? 'top' : 'left']: '50%', [vertical ? 'marginTop' : 'marginLeft']: -lengthPx / 2 };
    const size = vertical ? { width: thicknessPx, height: lengthPx } : { width: lengthPx, height: thicknessPx };
    const across = direction === 'left' ? { left: insetPx } : direction === 'right' ? { right: insetPx }
        : direction === 'up' ? { top: insetPx } : { bottom: insetPx };
    return { ...along, ...size, ...across } as ViewStyle;
}

const stylesheet = StyleSheet.create((theme) => ({
    zone: {
        position: 'absolute',
        borderRadius: ZONE_RADIUS_PX,
        borderWidth: 1.5,
        borderColor: theme.colors.state.active.border,
        overflow: 'hidden',
    },
    tint: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.colors.state.active.background,
    },
    veil: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.colors.surface.base,
        opacity: 0.7,
    },
    edgeMark: {
        position: 'absolute',
        borderRadius: 3,
        backgroundColor: theme.colors.state.active.foreground,
        opacity: 0.6,
    },
}));

const WEB_FROST = Platform.OS === 'web' ? ({ backdropFilter: 'blur(6px) saturate(1.1)' } as unknown as ViewStyle) : null;
/**
 * Centre ⇄ edge glides on web instead of jumping (the zone keeps its element while the pointer moves
 * within one pane). Native and reduced motion switch instantly.
 */
const WEB_ZONE_GLIDE = Platform.OS === 'web' ? ({
    transitionProperty: 'top, right, bottom, left',
    transitionDuration: `${HAPPIER_MOTION_V1.fastMs}ms`,
    transitionTimingFunction: HAPPIER_MOTION_V1.standardEasingCss,
} as unknown as ViewStyle) : null;

export const SplitCanvasDropOverlay = React.memo((props: Readonly<{
    target: SplitCanvasDropTarget | null;
    /** Edges the pane can still split, marked while the centre is the target. */
    edgeMarks?: readonly SplitCanvasDirection[];
}>) => {
    useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const styles = stylesheet;
    if (!props.target) return null;
    const { leafId, placement } = props.target;
    const edge = placement !== 'center';
    return (
        <View pointerEvents="none" style={StyleSheet.absoluteFillObject}
            accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View testID={`split-canvas-drop-overlay-${leafId}-${placement}`}
                style={[styles.zone, zoneFrame(placement), edge ? WEB_FROST : null, reducedMotion ? null : WEB_ZONE_GLIDE]}>
                {edge ? <View style={styles.veil} /> : null}
                <View style={styles.tint} />
            </View>
            {!edge ? (props.edgeMarks ?? []).map(direction => (
                <View key={direction} testID={`split-canvas-drop-edge-${leafId}-${direction}`}
                    style={[styles.edgeMark, edgeMarkFrame(direction)]} />
            )) : null}
        </View>
    );
});
