import * as React from 'react';
import { normalizeSessionListFilterV1, type SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { WorkBoardIntentV1, WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';

import {
    buildSessionListFilterEditorLabels,
    readSessionListScopeLabel,
} from '@/components/sessions/shell/search/SessionListFilterControl';
import { SessionListFilterEditorControl } from '@/components/sessions/shell/search/SessionListFilterEditorControl';
import {
    removeUnavailableSessionListFilterSelections,
    type SessionListViewFilters,
} from '@/components/sessions/shell/search/sessionListViewFilters';
import { useSessionListFilterEditorOptions } from '@/components/sessions/shell/search/useSessionListFilterEditorOptions';

import { fromStoredSessionListFilter, toStoredSessionListFilter } from '@/components/sessions/shell/search/storedSessionListFilter';
import type { BoardHomes } from '../model/useBoardContent';

const NO_OP = () => {};

/**
 * The board's inline Sessions filter, edited with the Sessions list's own editor and options owners
 * (one `SessionListFilterV1` model). Only the selection is the board's; inactive Sessions stay out,
 * as on an active board.
 */
export const BoardSessionFilterControl = React.memo(function BoardSessionFilterControl(props: Readonly<{
    board: WorkBoardV1;
    filter: SessionListFilterV1;
    homes: BoardHomes;
    dispatch: (intent: WorkBoardIntentV1) => void;
}>) {
    const { board, dispatch, homes } = props;
    const mounted = homes.mountedServerIds;
    const filters = React.useMemo(() => fromStoredSessionListFilter(props.filter, mounted), [mounted, props.filter]);
    const selected = filters.homeServerIds;
    const options = useSessionListFilterEditorOptions(mounted, selected);

    const save = React.useCallback((next: SessionListViewFilters) => dispatch({
        kind: 'update',
        boardId: board.id,
        patch: {
            source: {
                filter: toStoredSessionListFilter(next),
            },
        },
    }), [board.id, dispatch]);
    const latestFilters = React.useRef(filters);
    latestFilters.current = filters;

    return (
        <SessionListFilterEditorControl
            label={readSessionListScopeLabel(filters.scope)}
            active={filters.attention !== 'any' || filters.audiences.include.length + filters.audiences.exclude.length > 0 || filters.tagIds.include.length + filters.tagIds.exclude.length > 0 || filters.source !== 'all'
                || selected.length !== mounted.length}
            editor={{
                filters,
                ...options,
                includeInactive: false,
                inactiveVisibilityAvailable: false,
                labels: buildSessionListFilterEditorLabels(),
                updateFilters: save,
                removeAuthoritativelyDeletedSelections: (deleted) => {
                    const next = removeUnavailableSessionListFilterSelections(latestFilters.current, deleted);
                    if (next !== latestFilters.current) save(next);
                },
                setIncludeInactive: NO_OP,
                setSource: (source) => save({ ...latestFilters.current, source }),
                resetFilters: () => save(fromStoredSessionListFilter(normalizeSessionListFilterV1(), mounted)),
            }}
        />
    );
});
