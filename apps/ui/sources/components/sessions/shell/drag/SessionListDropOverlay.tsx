import * as React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';

import {
    TreeDropOverlay,
    type TreeDropOverlaySharedValues,
} from '@/components/ui/treeDragDrop';

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
    /** Numeric, worklet-readable overlay geometry shared values. */
    shared: TreeDropOverlaySharedValues;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

export function SessionListDropOverlay(props: SessionListDropOverlayProps): React.ReactElement {
    return (
        <TreeDropOverlay
            shared={props.shared}
            indentPx={SESSION_LIST_DROP_OVERLAY_INDENT_PX}
            testID={props.testID}
            style={props.style}
        />
    );
}
