import { normalizeSessionListFilterV1, type SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import type { SessionListViewFilters } from '@/components/sessions/shell/search/sessionListViewFilters';

/**
 * A board's inline Sessions filter is the Sessions list's own `SessionListFilterV1`, edited with the
 * Sessions list's own editor. These two adapters are the whole difference: a board that names no Home
 * means every mounted Home (as the list does), and only the selection is stored — never search text.
 */
export function fromBoardSessionFilter(filter: SessionListFilterV1, mountedServerIds: readonly string[]): SessionListViewFilters {
    const homeServerIds = filter.homeServerIds.length > 0 ? filter.homeServerIds : mountedServerIds;
    return { ...normalizeSessionListFilterV1({ ...filter, homeServerIds }), searchQuery: '' };
}

export function toBoardSessionFilter(filters: SessionListViewFilters): SessionListFilterV1 {
    const { searchQuery: _searchQuery, ...selection } = filters;
    return normalizeSessionListFilterV1(selection);
}
