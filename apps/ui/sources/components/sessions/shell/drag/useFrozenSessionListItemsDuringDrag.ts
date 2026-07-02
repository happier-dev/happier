/**
 * Chooses which session-list projection `SessionsList` renders: the FROZEN
 * snapshot order while a drag is active, or the latest LIVE list otherwise.
 *
 * Phase 2 of the session-list drag geometry & performance unification
 * (`.project/plans/session-list-drag-geometry-performance-unification.md`,
 * section 3.3). It only selects; it never blocks background store updates. The
 * frozen order comes straight from the snapshot held by the caller, so a
 * background reorder during an active drag does NOT move the visible surface
 * (the snapshot is captured once at drag start and never mutated). After
 * drop/cancel the caller clears the snapshot and the latest live list renders.
 *
 * No per-pointer-move React state lives here: the projection only flips when
 * the active snapshot itself flips (drag start/end), driven by the caller's
 * minimal `activeDragSnapshotId` state.
 */

import * as React from 'react';

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
            return {
                frozen: true,
                viewItems: activeSnapshot.frozenViewItems,
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
