import { matchSessionBotFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import type { SessionListQueryHomeState } from '@/sync/domains/session/listing/sessionListQueryController';
import { isSessionListQueryRowPlaceable } from '@/sync/domains/session/listing/sessionListQuerySelection';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { retainDeep } from '@/sync/domains/state/structuralSharing';

/**
 * The seeder installs a complete local corpus. Its unqualified accessible query
 * needs no Account or remote pagination. Selectors requiring Home-published
 * personal/organization facts stay unsupported rather than broadening a query.
 */
export function buildDemoSessionListQueryState(input: Readonly<{
    serverId: string;
    queryKey: string;
    query: SessionListQueryV1;
    rows: Readonly<Record<string, SessionListRenderableSession>>;
    enabled: boolean;
    previous?: SessionListQueryHomeState;
}>): SessionListQueryHomeState {
    const supported = isSessionListQueryRowPlaceable(input.query)
        && input.query.membership === undefined
        && input.query.scope === 'all_accessible'
        && input.query.includeInactive
        && input.query.attention === 'any';
    const phase = !input.enabled ? 'not_selected' : supported ? 'ready' : 'error';
    const addresses = phase === 'ready' ? Object.values(input.rows).filter(row =>
        (input.query.storage === 'archived') === (row.archivedAt != null)
        && (input.query.bot === undefined || matchSessionBotFilterV1(row.metadata, input.query.bot) === 'match'))
        .map(row => ({ serverId: input.serverId, sessionId: row.id })) : [];
    return retainDeep<SessionListQueryHomeState>(input.previous, {
        requestedQueryKey: input.queryKey,
        appliedQueryKey: phase === 'ready' ? input.queryKey : null,
        addresses,
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
        phase, freshnessAt: null, homeObservation: { phase, lastSuccessAt: null },
        failureReason: phase === 'error' ? 'unsupported' : null,
        failureCode: null,
        appliedSourceKind: phase === 'ready' ? 'query' : null,
    });
}
