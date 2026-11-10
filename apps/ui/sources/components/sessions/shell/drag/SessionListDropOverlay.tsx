import * as React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';

import {
    TreeDropOverlay,
    type TreeDropOverlaySharedValues,
} from '@/components/ui/treeDragDrop';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

/**
 * Session-list wrapper around the generic list-level `TreeDropOverlay`.
 *
 * Phase 3 of the session-list drag geometry & performance unification
 * (`.project/plans/session-list-drag-geometry-performance-unification.md`,
 * section 3.4). This is the ONE viewport-level drop indicator for the session
 * list. It replaces the per-row `SessionListDropIndicator`: a pointer move never
 * reconciles mounted rows because the overlay's position flows entirely through
 * the numeric `TreeDropOverlaySharedValues`.
 *
 * It owns the session-specific indent constant (migrated from the deleted
 * `SessionListDropIndicator`) and otherwise delegates rendering, theming,
 * motion-token glides, and reduced-motion snapping to the generic overlay.
 */

/**
 * Per-depth horizontal indent applied to the reorder line, in px. Migrated
 * verbatim from the deleted `SessionListDropIndicator`'s
 * `SESSION_LIST_FOLDER_INDENT_PX` so nested folder reorder lines read at the
 * same indent they did before the overlay unification.
 */
export const SESSION_LIST_DROP_OVERLAY_INDENT_PX = 6;

export type SessionListDropOverlayProps = Readonly<{
    /** The owning list's React carry lifecycle; geometry remains on the UI thread. */
    active: boolean;
    /** Numeric, worklet-readable overlay geometry shared values. */
    shared: TreeDropOverlaySharedValues;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

export function SessionListDropOverlay(props: SessionListDropOverlayProps): React.ReactElement | null {
    if (!props.active) return null;

    return (
        <TreeDropOverlay
            shared={props.shared}
            indentPx={SESSION_LIST_DROP_OVERLAY_INDENT_PX}
            // Rows are measured across the column; their sheet sits one gutter in, and their text one
            // more. The outline lies on the row's frame and the line starts at the text edge (lab E1s).
            frameInsetPx={HAPPIER_COLLECTION_LIST_METRICS.rowInset}
            lineInsetPx={HAPPIER_COLLECTION_LIST_METRICS.contentInset - HAPPIER_COLLECTION_LIST_METRICS.rowInset}
            outlineRadius={HAPPIER_COLLECTION_LIST_METRICS.rowRadius}
            testID={props.testID}
            style={props.style}
        />
    );
}
