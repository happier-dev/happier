import * as React from 'react';

import {
    useSessionListQueryHomeStates,
    useSessionListQueryHomeSupportByServerId,
} from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * Reads the archived Sessions this Session once led, so the Work pane can say they exist.
 *
 * Archived rows are not part of the ordinary list, so nothing else brings them to the client. This is the
 * Sessions list's own exact-Home subtree query, asked for the archived corpus under this lead (the Bots
 * roster asks the same query for the active one). It hydrates the shared rows without publishing a
 * membership of its own; the Work projection reads those rows from the store like every other report. A
 * Home that cannot answer a filtered listing simply shows none, as before.
 */
export function useSessionArchivedReports(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    enabled: boolean;
}>): Readonly<{ loading: boolean }> {
    const serverId = params.serverId?.trim() ?? '';
    const active = params.enabled && serverId !== '';
    const homeIds = React.useMemo(() => [serverId], [serverId]);
    const support = useSessionListQueryHomeSupportByServerId(homeIds, active);
    const homes = React.useMemo(() => [{
        serverId,
        queryMembership: 'rowOnly' as const,
        query: {
            v: 1 as const, storage: 'archived' as const, includeInactive: true,
            scope: 'all_accessible' as const, attention: 'any' as const, audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] },
            underSessionId: params.sessionId,
        },
    }], [params.sessionId, serverId]);
    const query = useSessionListQueryHomeStates({ enabled: active && support[serverId] === true, homes });
    const state = query.statesByServerId[serverId];
    const cursor = state?.phase === 'ready' && (state.hasNext || state.attentionHasNext)
        ? `${state.nextCursor}:${state.attentionNextCursor}` : '';
    React.useEffect(() => {
        if (cursor) fireAndForget(query.loadNext(), { tag: 'SessionWork.archivedReports.loadNext' });
    }, [cursor, query]);
    // Until the first answer (the Home's support, then the query's first page), the pane cannot say whether
    // this Session ever led anything. A Home that answers "no", or a query that settled, ends the wait.
    const settled = state !== undefined && state.phase !== 'idle' && state.phase !== 'loading';
    return { loading: active && support[serverId] !== false && !settled };
}
