import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_DROP_INDICATOR_METRICS, HAPPIER_MOTION_V1 } from '@happier-dev/plugin-ui/presentation';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { SplitCanvasDirection, SplitCanvasDropTarget } from '../model/splitCanvasTypes';
import { readSplitCanvasDropZone } from '../model/splitCanvasDropTarget';

/**
 * The pane zone (DnD lab C2/C2s). Geometry only: what releasing does is said on the carried card.
 *
 * - Centre: the whole pane takes a soft outline and a light tint its content stays readable under,
 *   with a short mark at each edge the pane can still split. A pane too narrow to split shows no marks.
 * - Edge: a frosted band shows where release splits, not the eventual half-pane size.
 *
 * The zone sits inset from the pane edge so it never reads as the pane's own border.
 */

const ZONE_INSET_PX = 8;
const ZONE_RADIUS_PX = 12;
const EDGE_MARK = Object.freeze({ thicknessPx: 4, lengthPx: 36, insetPx: 10, radiusPx: 2 });

function zoneFrame(placement: SplitCanvasDropTarget['placement']): ViewStyle {
    const zone = readSplitCanvasDropZone(placement);
    return { top: `${zone.top * 100}%`, bottom: `${(1 - zone.bottom) * 100}%`,
        left: `${zone.left * 100}%`, right: `${(1 - zone.right) * 100}%` };
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
        // A container outline: the same stroke a group takes when a widget would enter it.
        borderWidth: HAPPIER_DROP_INDICATOR_METRICS.containerOutlinePx,
        borderColor: theme.colors.state.active.border,
        overflow: 'hidden',
    },
    tint: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.colors.state.active.background,
    },
    // The centre keeps the pane readable: half the band's tint, no veil, no frost.
    softTint: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.colors.state.active.background,
        opacity: 0.5,
    },
    veil: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.colors.surface.base,
        opacity: 0.7,
    },
    edgeMark: {
        position: 'absolute',
        borderRadius: EDGE_MARK.radiusPx,
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
                style={[{ position: 'absolute' }, edge ? zoneFrame(placement) : StyleSheet.absoluteFillObject, reducedMotion ? null : WEB_ZONE_GLIDE]}>
                <View style={[styles.zone, { top: ZONE_INSET_PX, bottom: ZONE_INSET_PX, left: ZONE_INSET_PX, right: ZONE_INSET_PX }, edge ? WEB_FROST : null]}>
                    {edge ? <View style={styles.veil} /> : null}
                    <View style={edge ? styles.tint : styles.softTint} />
                </View>
            </View>
            {!edge ? (props.edgeMarks ?? []).map(direction => (
                <View key={direction} testID={`split-canvas-drop-edge-${leafId}-${direction}`}
                    style={[styles.edgeMark, edgeMarkFrame(direction)]} />
            )) : null}
        </View>
    );
});
