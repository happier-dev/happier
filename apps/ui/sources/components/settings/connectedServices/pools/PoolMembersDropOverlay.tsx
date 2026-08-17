import * as React from 'react';

import {
    TreeDropOverlay,
    type TreeDropOverlaySharedValues,
} from '@/components/ui/treeDragDrop';

/**
 * Pools-members wrapper around the generic list-level `TreeDropOverlay`.
 *
 * This is the ONE drop indicator (the insertion line) for the pool
 * member-reorder list, mirroring the session list's overlay. Its geometry flows
 * entirely through numeric `TreeDropOverlaySharedValues` written by
 * `useListInlineReorder`, so a drag never reconciles the mounted member rows. It
 * is rendered as an absolutely-positioned sibling of the member rows, inside a
 * `position: 'relative'` container.
 *
 * Pool members are a flat list (no nesting), so the per-depth indent is 0.
 */
const POOL_MEMBERS_DROP_OVERLAY_INDENT_PX = 0;

export type PoolMembersDropOverlayProps = Readonly<{
    /** Numeric, worklet-readable overlay geometry shared values. */
    shared: TreeDropOverlaySharedValues;
    testID?: string;
}>;

export function PoolMembersDropOverlay(props: PoolMembersDropOverlayProps): React.ReactElement {
    return (
        <TreeDropOverlay
            shared={props.shared}
            indentPx={POOL_MEMBERS_DROP_OVERLAY_INDENT_PX}
            testID={props.testID}
        />
    );
}
