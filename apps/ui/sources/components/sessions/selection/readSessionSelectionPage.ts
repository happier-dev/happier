import type { PluginUiSelectActionInputRequestV1 } from '@happier-dev/protocol/plugins/ui';
import { sameScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';

import { fetchSessionListQueryPageForHome } from '@/sync/domains/session/listing/sessionListQueryRuntime';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readSessionListAcceptedWorkspaceRef } from '@/sync/domains/session/sessionAcceptedWorkspace';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { projectSessionSelectionRows, type SessionSelectionRow } from './projectSessionSelectionRows';
import { isWritableSessionSelectionCandidate } from './sessionSelectionCandidates';

export type SessionSelectionPageReader = (cursor: string | null, signal: AbortSignal) => Promise<Readonly<{
    rows: readonly SessionSelectionRow[];
    nextCursor: string | null;
}>>;

type CandidateQuery = NonNullable<Extract<PluginUiSelectActionInputRequestV1,
    { sessionCandidateQuery?: unknown }>['sessionCandidateQuery']>;

export function createSessionSelectionPageReader(scope: ServerAccountScope, query: CandidateQuery): SessionSelectionPageReader {
    return async (cursor, signal) => {
        const page = await fetchSessionListQueryPageForHome(scope.serverId, {
            membership: 'rowOnly',
            hydration: 'inline',
            source: { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: true },
            cursor,
            signal,
        });
        if (!page.current) throw new Error('Session selection page retired');
        const state = storage.getState();
        const rows = readSessionListRowsForServerId(state.sessionListRowsByServerId, scope.serverId);
        const candidates = page.sessionIds.flatMap(id => {
            const row = rows?.[id];
            if (!row || page.isSessionCurrent?.(id) === false || row.archivedAt != null) return [];
            const candidate = { ...row, serverId: scope.serverId };
            if (!isWritableSessionSelectionCandidate(candidate)) return [];
            if (query.workspace === 'accepted') {
                const checkout = readSessionListAcceptedWorkspaceRef(row, scope, state);
                if (!checkout || (query.repository !== undefined
                    && !sameScmHostingRepositoryIdentity(query.repository, checkout.repositoryIdentity))) return [];
            }
            return [candidate];
        });
        return { rows: projectSessionSelectionRows(candidates), nextCursor: page.hasNext ? page.nextCursor : null };
    };
}
