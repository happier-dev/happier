import * as React from 'react';
import type { WorkBoardIntentV1, WorkBoardV1, WorkBoardWidgetPlacementV1 } from '@happier-dev/protocol';
import { captureWorkBoardWidgetMoveV1 } from '@happier-dev/protocol/widgets';

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
    return useAcknowledgedBoardWidgetArrivals(boardId, acknowledged, ownAdds, dispatch);
}

export function useAcknowledgedBoardWidgetArrivals(
    boardId: string,
    acknowledged: WorkBoardV1 | null,
    ownAdds: ReadonlySet<string>,
    dispatch: (intent: WorkBoardIntentV1) => Promise<unknown>,
) {
    const placements = acknowledged?.widgets;
    const ready = acknowledged !== null;
    const ids = React.useMemo(() => (ready ? (placements ?? []).map(placement => placement.instance.id) : null), [ready, placements]);
    const seen = useSessionBoardArrivals(ids);
    const captured = React.useRef(new Map<string, Readonly<{
        placement: WorkBoardWidgetPlacementV1;
        capture: NonNullable<ReturnType<typeof captureWorkBoardWidgetMoveV1>>;
    }>>());
    if (acknowledged) {
        for (const placement of placements ?? []) {
            const id = placement.instance.id;
            if (!seen.has(id) || ownAdds.has(id) || captured.current.has(id)) continue;
            const capture = captureWorkBoardWidgetMoveV1(acknowledged, placement.ref.surface, id);
            if (capture) captured.current.set(id, { placement, capture });
        }
    }
    const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(() => new Set());
    const arrived = React.useMemo(() => new Set([...seen].filter(id => !ownAdds.has(id))), [ownAdds, seen]);
    const pending = React.useMemo(() => resolveBoardWidgetArrivals({ placements: placements ?? [], seen, ownAdds, dismissed }),
        [dismissed, ownAdds, placements, seen]);
    const dismiss = React.useCallback(() => {
        setDismissed(previous => new Set([...previous, ...pending.map(placement => placement.instance.id)]));
    }, [pending]);
    const undo = React.useCallback(async () => {
        dismiss();
        const removals = pending.flatMap(placement => {
            const arrival = captured.current.get(placement.instance.id);
            return arrival ? [arrival] : [];
        }).sort((left, right) => right.capture.expectedPresentation.nativeIndex - left.capture.expectedPresentation.nativeIndex);
        // Removing from the end preserves the captured indices of the remaining arrivals.
        for (const { placement, capture } of removals) {
            await dispatch({ kind: 'widget_remove', boardId, ref: placement.ref, ...capture });
        }
    }, [boardId, dismiss, dispatch, pending]);
    return { arrived, pending, dismiss, undo };
}
