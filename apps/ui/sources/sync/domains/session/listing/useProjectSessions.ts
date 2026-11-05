import * as React from 'react';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { normalizeSessionListFilterV1, type SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { buildSessionListFilterQueryHomes, createSessionListViewFilterDefaults } from '@/components/sessions/shell/search/sessionListViewFilters';
import { useActiveServerAccountScope, useSessionListRowsByServerId } from '@/sync/domains/state/storage';
import { useProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { readSessionListRowsForServerId } from './sessionListRowStateLookup';
import { useSessionListQueryHomeSupportByServerId, useSessionListQuerySourceState } from './useSessionListQuerySourceState';
import { resolveSessionListQueryPresentation } from './sessionListIndexPresentation';
import { projectSessionList } from './projectSessionList';
import { canSessionListOrdinaryPageAnswerQuery } from './sessionListQueryController';
import { computeVisibleSessionListIndex } from './computeVisibleSessionListIndex';
import { filterSessionListIndexByStorageKind } from './filterSessionListIndexByStorageKind';
import { useServerCredentialAccountScopes } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { SessionListRenderableSession } from './sessionListRenderable';

const DEFAULT_FILTER = normalizeSessionListFilterV1({ show: 'sessions', startedBy: ['you', 'agents', 'triggers'] });
const NO_ROWS: Readonly<Record<string, SessionListRenderableSession>> = Object.freeze({});

/** The ordinary Session list's paging, visibility and row contracts, narrowed to an accepted Project. */
export function useProjectSessions(project: QualifiedProjectKeyV1 | null, filter: SessionListFilterV1 = DEFAULT_FILTER) {
    const activeViewer = useActiveServerAccountScope(project?.serverId ?? null);
    const refs = useProjectAccountWorkspaceRefs(project !== null);
    const candidateHomes = React.useMemo(() => project && activeViewer ? [activeViewer.serverId] : [], [project?.serverId, activeViewer]);
    const bindings = useServerCredentialAccountScopes(candidateHomes);
    const binding = activeViewer ? bindings.get(activeViewer.serverId) : null;
    const viewer = binding?.isCurrent() && areServerAccountScopesEqual(binding.scope, activeViewer) ? activeViewer : null;
    const homeIds = React.useMemo(() => project && viewer ? candidateHomes : [], [candidateHomes, viewer]);
    const filters = React.useMemo(() => createSessionListViewFilterDefaults({ ...filter, show: 'sessions', homeServerIds: homeIds }), [filter, homeIds]);
    // Published Project identities let the Home narrow candidates before paging.
    // Unpublished identities still need the roster's local membership matcher.
    const queryFilters = React.useMemo(() => project ? { ...filters,
        projects: { include: [{ serverId: project.serverId, projectKey: project.projectKey }], exclude: [] } } : filters,
    [filters, project?.serverId, project?.projectKey]);
    const projectHomes = React.useMemo(() => buildSessionListFilterQueryHomes(queryFilters, {
        storage: 'active', includeInactive: true, mountedHomeServerIds: homeIds, projectFacet: 'query',
    }), [queryFilters, homeIds]);
    const projectQueriesByServerId = React.useMemo(() => new Map(projectHomes.map(home => [home.serverId, home.query])), [projectHomes]);
    const projectSelectionSupport = useSessionListQueryHomeSupportByServerId(homeIds, homeIds.length > 0, projectQueriesByServerId);
    const homes = React.useMemo(() => projectHomes.map(home => {
        const query = { ...home.query };
        // Older strict readers cannot accept the selector. Preserve their existing
        // candidate path and complete local matching instead of hiding members.
        if (projectSelectionSupport[home.serverId] === false) delete query.projectKeys;
        return { ...home, query, queryMembership: 'rowOnly' as const,
            ordinaryAdapter: canSessionListOrdinaryPageAnswerQuery(query)
                ? { path: '/v2/sessions', allowV1Fallback: true, membership: 'ordinary' as const } : null };
    }), [projectHomes, projectSelectionSupport]);
    const query = useSessionListQuerySourceState({ enabled: homeIds.length > 0, homes });
    const rowsByHome = useSessionListRowsByServerId(homeIds);
    const rows = readSessionListRowsForServerId(rowsByHome, project?.serverId) ?? NO_ROWS;
    const source = React.useMemo(() => {
        const resolveSessionRow = (_serverId: string | null | undefined, sessionId: string) => rows[sessionId] ?? null;
        return computeVisibleSessionListIndex({ source: filterSessionListIndexByStorageKind(query.source, filters.source, resolveSessionRow),
            resolveSessionRow, hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {}, workFilter: filters, workspaceRefs: refs,
            viewerAccountIdByServerId: viewer ? new Map([[viewer.serverId, viewer.accountId]]) : undefined,
            presentation: { enabled: true, presentation: 'flat-with-badge', selectedServerIds: homeIds } });
    }, [query.source, filters, rows, homeIds, refs, viewer]);
    const roster = React.useMemo(() => project ? projectSessionList({ project, viewer, source, rows, workspaceRefs: refs })
        : { items: [], unavailableCount: 0 }, [project?.serverId, project?.projectKey, viewer, source, rows, refs]);
    // Account cursors describe candidates, not Project matches. Advance at the
    // roster owner so an empty candidate page never asks the viewer to page it.
    const seekingMatches = viewer !== null && roster.items.length === 0
        && Object.values(query.statesByServerId).some(state => state?.phase === 'ready'
            && (state.hasNext || state.attentionHasNext));
    React.useEffect(() => {
        if (seekingMatches) void query.loadNext();
    }, [seekingMatches, query.loadNext, query.statesByServerId]);
    const presentation = React.useMemo(() => seekingMatches ? { kind: 'initial_loading' as const }
        : resolveSessionListQueryPresentation({ selectedServerIds: homeIds,
        statesByServerId: query.statesByServerId, coverageComplete: query.coverageComplete && roster.unavailableCount === 0,
        retainedRowCount: roster.items.length }), [seekingMatches, homeIds, query.statesByServerId, query.coverageComplete, roster]);
    return React.useMemo(() => ({ ...roster, filters, presentation, query,
        access: viewer && project ? 'available' as const : 'unavailable' as const }), [roster, filters, presentation, query, viewer, project?.serverId, project?.projectKey]);
}

export type ProjectSessionsState = ReturnType<typeof useProjectSessions>;
