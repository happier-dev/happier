/**
 * Chooses which session-list projection `SessionsList` renders: the FROZEN
 * snapshot order while a drag is active, or the latest LIVE list otherwise.
 *
 * Phase 2 of the session-list drag geometry & performance unification
 * (`.project/plans/session-list-drag-geometry-performance-unification.md`,
 * section 3.3). It only selects; it never blocks background store updates. The
 * frozen order comes straight from the snapshot held by the caller, so a
 * background reorder during an active drag does NOT move the visible surface.
 * Current facts and deleted/revoked withdrawals come from the admitted live index;
 * the snapshot itself is never mutated. At effect dispatch (or cancellation),
 * the caller clears the snapshot so optimistic membership, placement and rollback
 * come from the same live projection while the effect owner settles the outcome.
 *
 * No per-pointer-move React state lives here: the projection only flips when
 * the active snapshot itself flips (drag start/end), driven by the caller's
 * minimal `activeDragSnapshotId` state.
 */

import * as React from 'react';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndexIdentity';

import type {
    FrozenSessionListProjectionInput,
    FrozenSessionListProjectionResult,
} from './_types';

export function useFrozenSessionListItemsDuringDrag(
    input: FrozenSessionListProjectionInput,
): FrozenSessionListProjectionResult {
    const { activeSnapshot, liveViewItems } = input;

    return React.useMemo<FrozenSessionListProjectionResult>(() => {
        if (activeSnapshot) {
            // Freeze occurrence positions only. The admitted live index still
            // owns current facts and withdrawals, including same-id foreign Homes.
            const liveItemsById = new Map(liveViewItems.map(item => [buildSessionListIndexNodeId(item), item]));
            const frozenItems = activeSnapshot.frozenViewItems;
            const currentItems: (typeof liveViewItems)[number][] = [];
            let changed = false;
            for (const presentedItem of frozenItems) {
                const currentItem = liveItemsById.get(buildSessionListIndexNodeId(presentedItem));
                if (!currentItem) {
                    changed = true;
                    continue;
                }
                currentItems.push(currentItem);
                if (currentItem !== presentedItem) changed = true;
            }
            return {
                frozen: true,
                viewItems: changed ? currentItems : frozenItems,
                snapshotId: activeSnapshot.snapshotId,
            };
        }
        return {
            frozen: false,
            viewItems: liveViewItems,
            snapshotId: null,
        };
    }, [activeSnapshot, liveViewItems]);
}
