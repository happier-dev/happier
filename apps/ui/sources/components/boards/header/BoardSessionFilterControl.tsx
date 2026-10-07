import * as React from 'react';
import { normalizeSessionListFilterV1, type SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { WorkBoardIntentV1, WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';

import {
    buildSessionListFilterAudienceOptions,
    buildSessionListFilterEditorLabels,
    readSessionListScopeLabel,
} from '@/components/sessions/shell/search/SessionListFilterControl';
import { SessionListFilterEditorControl } from '@/components/sessions/shell/search/SessionListFilterEditorControl';
import { buildSessionListFilterTagOptions } from '@/components/sessions/shell/search/sessionListFilterTagOptions';
import {
    removeUnavailableSessionListFilterSelections,
    type SessionListViewContext,
    type SessionListViewFilters,
} from '@/components/sessions/shell/search/sessionListViewFilters';
import {
    buildSessionListFilterHomeOptions,
    resolveSelectedHomeFeatureAvailability,
} from '@/components/sessions/shell/search/useSessionListViewFilterController';
import {
    useSessionListFeatureHomeSupportByServerId,
    useSessionListQueryHomeSupportByServerId,
} from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { useSessionOrganizationProjections } from '@/sync/domains/state/storage';

import { fromBoardSessionFilter, toBoardSessionFilter } from '../model/boardSessionFilter';
import type { BoardHomes } from '../model/useBoardContent';

const GLOBAL_CONTEXT: SessionListViewContext = { kind: 'global' };
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
    const filters = React.useMemo(() => fromBoardSessionFilter(props.filter, mounted), [mounted, props.filter]);
    const homeOptions = React.useMemo(() => buildSessionListFilterHomeOptions(mounted), [mounted]);
    const audiences = React.useMemo(() => buildSessionListFilterAudienceOptions(homeOptions, GLOBAL_CONTEXT), [homeOptions]);
    const organizationProjections = useSessionOrganizationProjections(mounted);
    const tags = React.useMemo(() => buildSessionListFilterTagOptions({
        homeOptions,
        organizationProjectionsByServerId: organizationProjections,
    }), [homeOptions, organizationProjections]);
    const selected = filters.homeServerIds;
    const queryEnabled = resolveSelectedHomeFeatureAvailability(selected, useSessionListQueryHomeSupportByServerId(selected, true));
    const followingAvailable = resolveSelectedHomeFeatureAvailability(
        selected,
        useSessionListFeatureHomeSupportByServerId('sessions.following', selected, true),
    );
    const sourceAvailable = resolveSelectedHomeFeatureAvailability(
        selected,
        useSessionListFeatureHomeSupportByServerId('sessions.direct', selected, true),
    );

    const save = React.useCallback((next: SessionListViewFilters) => dispatch({
        kind: 'update',
        boardId: board.id,
        patch: {
            source: {
                filter: toBoardSessionFilter(next),
            },
        },
    }), [board.id, dispatch]);
    const latestFilters = React.useRef(filters);
    latestFilters.current = filters;

    return (
        <SessionListFilterEditorControl
            label={readSessionListScopeLabel(filters.scope)}
            active={filters.attention !== 'any' || filters.audiences.length > 0 || filters.tagIds.length > 0 || filters.source !== 'all'
                || selected.length !== mounted.length}
            editor={{
                filters,
                includeInactive: false,
                inactiveVisibilityAvailable: false,
                queryEnabled,
                followingAvailable,
                sourceAvailable,
                homes: homeOptions,
                audiences,
                teamAudienceContext: GLOBAL_CONTEXT,
                tags,
                labels: buildSessionListFilterEditorLabels(),
                updateFilters: save,
                removeAuthoritativelyDeletedSelections: (deleted) => {
                    const next = removeUnavailableSessionListFilterSelections(latestFilters.current, deleted);
                    if (next !== latestFilters.current) save(next);
                },
                setIncludeInactive: NO_OP,
                setSource: (source) => save({ ...latestFilters.current, source }),
                resetFilters: () => save(fromBoardSessionFilter(normalizeSessionListFilterV1(), mounted)),
            }}
        />
    );
});
