import * as React from 'react';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import {
    teamGroupsQueryKeyV1,
    type TeamGroupMemberV1,
    type TeamGroupV1,
} from '@happier-dev/protocol/teams';

import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopedTeamResourceKey, type TeamAddress } from '@/sync/domains/teams/teamAddress';
import {
    loadMoreTeamGroups,
    observeTeamGroup,
    observeTeamGroups,
    refreshTeamGroup,
    refreshTeamGroups,
} from '@/sync/engine/teams/teamsDirectoryEngine';
import { listTeamGroupMembers } from '@/sync/ops/teams/teamGroupOperations';
import {
    getTeamGroupSnapshot,
    getTeamGroupsSnapshot,
    subscribeTeamsSnapshots,
} from '@/sync/store/teams/teamsSnapshots';

import { useTeamPagedList, type TeamPagedList } from './useTeamPagedList';

export type TeamGroupsRoster = TeamPagedList<TeamGroupV1> & Readonly<{
    /** Retained rows cannot prove absence while their snapshot is stale or refreshing. */
    isCurrent: boolean;
}>;
export type TeamGroupMembersRoster = TeamPagedList<TeamGroupMemberV1>;

const NO_GROUPS: readonly TeamGroupV1[] = Object.freeze([]);

export type TeamGroupDetail = Readonly<{
    group: TeamGroupV1 | null;
    status: 'loading' | 'ready' | 'error';
    isCurrent: boolean;
    error: HomeDomainFailure | null;
    reload: () => Promise<void>;
}>;

/** One exact Group from the canonical AccountChange-aware point projection. */
export function useTeamGroup(params: Readonly<{
    scope: ServerAccountScope | null;
    address: TeamAddress | null;
    groupId: string;
    enabled: boolean;
}>): TeamGroupDetail {
    const { scope, address, groupId, enabled } = params;
    const active = enabled && scope !== null && address !== null && groupId !== '';

    React.useEffect(() => {
        if (!active || !scope || !address) return;
        return observeTeamGroup(scope, address, groupId);
    }, [active, scope, address, groupId]);

    const snapshot = React.useSyncExternalStore(
        subscribeTeamsSnapshots,
        () => (active ? getTeamGroupSnapshot(scope, address, groupId) : null),
        () => null,
    );

    const reload = React.useCallback(async () => {
        if (!active || !scope || !address) return;
        await refreshTeamGroup(scope, address, groupId);
    }, [active, scope, address, groupId]);

    return React.useMemo(() => Object.freeze({
        group: snapshot?.data ?? null,
        status: snapshot === null || snapshot.status === 'loading'
            ? 'loading' as const
            : snapshot.status === 'error'
                ? 'error' as const
                : 'ready' as const,
        isCurrent: snapshot?.status === 'ready' && snapshot.stale === false,
        error: snapshot?.error ? toRosterFailure(snapshot.error) : null,
        reload,
    }), [snapshot, reload]);
}

/**
 * The snapshot's failure in the shape every Team roster already renders. Both
 * describe the same Home answer; only the typed domain code is absent, because
 * a list read has no domain refusal to carry beyond its reachability outcome.
 */
function toRosterFailure(error: ScopedSnapshotError): HomeDomainFailure {
    return Object.freeze({ kind: error.kind, retryable: error.retryable, code: null });
}

/**
 * One Team's Groups, read from the shared Teams snapshot owner.
 *
 * Groups used to be paged into component-local state, which meant every mounted
 * surface held its own copy, none of them saw the Account-change wake, and none
 * were retired with their credential. They now come from the same scoped
 * snapshot owner as the Team directory and Team detail, so a Group label is
 * available synchronously to any surface that already subscribes once — session
 * rows, Activity, Inbox and notification context — instead of each card opening
 * its own read.
 *
 * `loading_more` is deliberately local: it describes this caller's own
 * in-flight continuation, not a fact about the shared projection.
 */
export function useTeamGroups(params: Readonly<{
    scope: ServerAccountScope | null;
    address: TeamAddress | null;
    archived: 'active' | 'archived';
    enabled: boolean;
}>): TeamGroupsRoster {
    const { scope, address, archived, enabled } = params;
    const active = enabled && scope !== null && address !== null;
    const queryKey = address ? teamGroupsQueryKeyV1({ v: 1, teamId: address.teamId, archived }) : '';

    React.useEffect(() => {
        if (!active || !scope || !address) return;
        return observeTeamGroups(scope, address, archived);
    }, [active, scope, address, archived]);

    const snapshot = React.useSyncExternalStore(
        subscribeTeamsSnapshots,
        () => (active ? getTeamGroupsSnapshot(scope, address, queryKey) : null),
        () => null,
    );

    const [loadingMore, setLoadingMore] = React.useState(false);

    const loadMore = React.useCallback(async () => {
        if (!active || !scope || !address) return;
        setLoadingMore(true);
        try {
            await loadMoreTeamGroups(scope, address, archived);
        } finally {
            setLoadingMore(false);
        }
    }, [active, scope, address, archived]);

    const reload = React.useCallback(async () => {
        if (!active || !scope || !address) return;
        await refreshTeamGroups(scope, address, archived);
    }, [active, scope, address, archived]);

    return React.useMemo(() => {
        const rows = snapshot?.data ?? NO_GROUPS;
        const status: TeamGroupsRoster['status'] = loadingMore
            ? 'loading_more'
            : snapshot === null || snapshot.status === 'loading'
                ? 'loading'
                : snapshot.status === 'error'
                    ? 'error'
                    // A refresh over rows already on screen is not a loading
                    // state: the previous Groups stay rendered and are stale.
                    : 'ready';
        return Object.freeze({
            rows,
            status,
            isCurrent: snapshot?.status === 'ready' && snapshot.stale === false,
            error: snapshot?.error ? toRosterFailure(snapshot.error) : null,
            hasMore: (snapshot?.nextCursor ?? null) !== null,
            loadMore,
            reload,
        });
    }, [snapshot, loadingMore, loadMore, reload]);
}

/**
 * One Group's effective roster. The page is over effective rows, so a person
 * contributed by native plus two directories appears exactly once — which is
 * why the Group's own `memberCount` and this list agree.
 *
 * This stays a paged read rather than a shared projection: a Group's member
 * list is only ever read by the open Group surface, so promoting it would add
 * retained state with no second consumer.
 */
export function useTeamGroupMembers(params: Readonly<{
    scope: ServerAccountScope | null;
    address: TeamAddress | null;
    groupId: string;
    enabled: boolean;
}>): TeamGroupMembersRoster {
    const serverId = params.scope?.serverId ?? '';
    const accountId = params.scope?.accountId ?? '';
    const teamId = params.address?.teamId ?? '';
    const { groupId } = params;

    const loadPage = React.useCallback(
        (cursor: string | null) => listTeamGroupMembers({
            scope: { serverId, accountId },
            address: { serverId, teamId },
            groupId,
            cursor,
        }),
        [serverId, accountId, teamId, groupId],
    );

    return useTeamPagedList<TeamGroupMemberV1>({
        key: params.scope && params.address
            ? serverAccountScopedTeamResourceKey(params.scope, params.address, 'group-members', groupId)
            : '',
        enabled: params.enabled && serverId !== '' && accountId !== '' && teamId !== '' && groupId !== '',
        loadPage,
        accountChange: { serverId, entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 },
    });
}
