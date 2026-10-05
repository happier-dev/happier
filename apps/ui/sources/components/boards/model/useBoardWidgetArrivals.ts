import * as React from 'react';
import type { WorkBoardIntentV1, WorkBoardWidgetPlacementV1 } from '@happier-dev/protocol';

import { useSessionBoardArrivals } from '@/components/sessions/board/useSessionBoardArrivals';

import { useAcknowledgedWorkBoard } from './useWorkBoards';

/**
 * Which acknowledged widgets are arrival news: those that appeared while the Board was on screen
 * (`seen`), minus this device's own adds and any the person already dismissed.
 */
export function resolveBoardWidgetArrivals(input: Readonly<{
    placements: readonly WorkBoardWidgetPlacementV1[];
    seen: ReadonlySet<string>;
    ownAdds: ReadonlySet<string>;
    dismissed: ReadonlySet<string>;
}>): readonly WorkBoardWidgetPlacementV1[] {
    return input.placements.filter(placement => input.seen.has(placement.instance.id)
        && !input.ownAdds.has(placement.instance.id) && !input.dismissed.has(placement.instance.id));
}

/** Undo for exactly the copies that arrived, each only while it is still the copy that arrived. */
export function buildBoardWidgetUndoIntents(boardId: string, arrived: readonly WorkBoardWidgetPlacementV1[]): readonly WorkBoardIntentV1[] {
    return arrived.map(placement => ({ kind: 'widget_remove', boardId, ref: placement.ref, expectedInstance: placement.instance }));
}

/**
 * Widgets that arrived while this Board was on screen from somewhere else — an agent's acknowledged
 * Action, another device (lab `dashboards` G1): each gets the frame's one-shot ring, and one line
 * offers Undo for exactly those copies. Only the Account's acknowledged Board counts, never this
 * device's pending edits; a copy edited since it arrived is kept by Undo.
 */
export function useBoardWidgetArrivals(
    boardId: string,
    ownAdds: ReadonlySet<string>,
    dispatch: (intent: WorkBoardIntentV1) => Promise<unknown>,
) {
    const acknowledged = useAcknowledgedWorkBoard(boardId);
    const placements = acknowledged?.widgets;
    const ready = acknowledged !== null;
    const ids = React.useMemo(() => (ready ? (placements ?? []).map(placement => placement.instance.id) : null), [ready, placements]);
    const seen = useSessionBoardArrivals(ids);
    const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(() => new Set());
    const arrived = React.useMemo(() => new Set([...seen].filter(id => !ownAdds.has(id))), [ownAdds, seen]);
    const pending = React.useMemo(() => resolveBoardWidgetArrivals({ placements: placements ?? [], seen, ownAdds, dismissed }),
        [dismissed, ownAdds, placements, seen]);
    const dismiss = React.useCallback(() => {
        setDismissed(previous => new Set([...previous, ...pending.map(placement => placement.instance.id)]));
    }, [pending]);
    const undo = React.useCallback(async () => {
        dismiss();
        await Promise.all(buildBoardWidgetUndoIntents(boardId, pending).map(dispatch));
    }, [boardId, dismiss, dispatch, pending]);
    return { arrived, pending, dismiss, undo };
}
