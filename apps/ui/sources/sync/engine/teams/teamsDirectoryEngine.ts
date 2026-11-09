import {
    TeamsPageV1Schema,
    TeamSummaryV1Schema,
    teamDirectoryQueryKeyV1,
    teamCredentialResourcesQueryKeyV1,
    teamGroupsQueryKeyV1,
    type TeamCredentialResourceListFilterV1,
    type TeamMembersListFilterV1,
    type TeamsListInputV1,
    type TeamCredentialResourceCatalogEntryV1,
} from '@happier-dev/protocol/teams';
import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import { TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { ProviderBrokerApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';

import { runTeamAction, type HomeDomainFailure } from '@/sync/ops/teams/teamActionClient';
import { getTeamGroup, listTeamGroups } from '@/sync/ops/teams/teamGroupOperations';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import {
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import {
    serverAccountScopedTeamKey,
    type TeamAddress,
} from '@/sync/domains/teams/teamAddress';
import {
    createScopedSnapshotLoader,
    type ScopedLoadTarget,
} from '@/sync/engine/scope/scopedSnapshotLoader';
import { loadTeamPageRange } from '@/sync/engine/teams/loadTeamPageRange';
import { listTeamMembers } from '@/sync/ops/teams/teamMemberReadOperations';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    getTeamCredentialResource,
    discoverEntitledTeamCredentialResources,
    listTeamCredentialResources,
} from '@/sync/ops/teams/teamCredentialOperations';
import {
    applyTeamCredentialResource,
    applyTeamCredentialResourceFailure,
    applyTeamCredentialResourceCatalog,
    applyTeamCredentialResourceCatalogFailure,
    applyTeamCredentialResourcesFailure,
    applyTeamCredentialResourcesPage,
    beginTeamCredentialResourceCatalogLoad,
    beginTeamCredentialResourceLoad,
    beginTeamCredentialResourcesLoad,
    getTeamCredentialResourceCatalogSnapshot,
    teamCredentialResourceCatalogKey,
    getTeamCredentialResourceSnapshot,
    getTeamCredentialResourcesSnapshot,
    applyTeamFailure,
    clearTeamsSnapshotsForServer,
    applyTeamGroupFailure,
    applyTeamGroupProjection,
    applyTeamGroupsFailure,
    applyTeamGroupsPage,
    applyTeamProjection,
    applyTeamsDirectoryFailure,
    applyTeamsDirectoryPage,
    beginTeamGroupLoad,
    beginTeamGroupsLoad,
    beginTeamMembersLoad,
    applyTeamMembersPage,
    applyTeamMembersFailure,
    getTeamMembersSnapshot,
    invalidateTeamMembersSnapshot,
    teamMembersQueryKey,
    teamMembersSnapshotKey,
    retireTeamMembersSnapshot,
    beginTeamLoad,
    beginTeamsDirectoryLoad,
    getTeamGroupSnapshot,
    getTeamGroupsSnapshot,
    getTeamSnapshot,
    getTeamsDirectorySnapshot,
    invalidateTeamCredentialResourceCatalog,
    invalidateTeamCredentialResourceSnapshot,
    invalidateTeamCredentialResourcesSnapshot,
    invalidateTeamGroupSnapshot,
    invalidateTeamGroupsSnapshot,
    invalidateTeamSnapshot,
    invalidateTeamsDirectorySnapshot,
    invalidateTeamsSnapshotsForServer,
} from '@/sync/store/teams/teamsSnapshots';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';

/**
 * Team directory loading for one exact Home and Account.
 *
 * Freshness — first observation, Account-change wake, retry — is delegated to
 * the shared scoped-snapshot loader, so this directory cannot develop a second
 * refresh policy that disagrees with Home governance.
 *
 * Team detail uses the same loader lifecycle now that the Team owner publishes
 * the strict `teams.get` input and result contracts.
 */

/**
 * Team, Group and directory rows are readable only because one Home credential
 * authorized them, so they are retired with it rather than left for whichever
 * Account replaces it.
 *
 * This watch is deliberately not scoped to observation, unlike the wake the
 * shared loader owns. A surface that unmounted still leaves rows that a label
 * reader can read synchronously, and those must not outlive the credential
 * either. It resolves the event's identifier the same way the scopes were
 * keyed, so a Home addressed by a local profile alias still retires its rows.
 */
subscribeHomeCredentialChange((event) => {
    clearTeamsSnapshotsForServer(resolveServerProfileScopeIdForIdentifier(event.serverId));
});

type TeamsDirectoryTarget = ScopedLoadTarget & Readonly<{
    scope: ServerAccountScope;
    input: TeamsListInputV1;
    queryKey: string;
}>;

function targetFor(scope: ServerAccountScope, input: TeamsListInputV1): TeamsDirectoryTarget {
    const queryKey = teamDirectoryQueryKeyV1(input);
    return {
        key: `${serverAccountScopeKeySuffix(scope)}${queryKey.length}:${queryKey}`,
        serverId: scope.serverId,
        scope,
        input,
        queryKey,
    };
}

function toSnapshotError(failure: HomeDomainFailure): ScopedSnapshotError {
    const kind: ScopedSnapshotError['kind'] = failure.kind === 'conflict' || failure.kind === 'outcome_unknown'
        ? 'unknown'
        : failure.kind;
    return { kind, retryable: failure.retryable, code: failure.code };
}

const loader = createScopedSnapshotLoader<TeamsDirectoryTarget>({
    load: async ({ scope, input, queryKey }, loadContext) => {
        beginTeamsDirectoryLoad(scope, queryKey);
        // A refresh always re-reads the first page: a cursor names a position in
        // a sequence that may have moved, and replaying it would duplicate rows.
        const result = await runTeamAction({
            scope,
            actionId: 'teams.list',
            input: { ...input, cursor: null },
            parse: value => TeamsPageV1Schema.parse(value),
            signal: loadContext.signal,
        });
        if (loadContext.signal.aborted) return;
        if (result.kind === 'succeeded') {
            applyTeamsDirectoryPage({
                scope,
                queryKey,
                items: result.value.items,
                nextCursor: result.value.nextCursor,
                observedAt: Date.now(),
                current: loadContext.isCurrent(),
            });
            return;
        }
        applyTeamsDirectoryFailure({ scope, queryKey, error: toSnapshotError(result.failure) });
    },
    shouldLoadOnObserve: ({ scope, queryKey }) => {
        const current = getTeamsDirectorySnapshot(scope, queryKey);
        if (!current) return true;
        if (current.stale) return true;
        return current.data === null && current.status !== 'loading';
    },
    invalidateServer: (serverId) => {
        invalidateTeamsSnapshotsForServer(serverId);
    },
    invalidateTarget: ({ scope, queryKey }) => {
        invalidateTeamsDirectorySnapshot(scope, queryKey);
    },
    matchesWake: (event) => event.entityIds === undefined
        || event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1),
});

type TeamTarget = ScopedLoadTarget & Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
}>;

function teamTargetFor(scope: ServerAccountScope, address: TeamAddress): TeamTarget | null {
    if (scope.serverId !== address.serverId) return null;
    return {
        key: serverAccountScopedTeamKey(scope, address),
        serverId: scope.serverId,
        scope,
        address,
    };
}

const teamLoader = createScopedSnapshotLoader<TeamTarget>({
    load: async ({ scope, address }, loadContext) => {
        beginTeamLoad(scope, address);
        const result = await runTeamAction({
            scope,
            actionId: 'teams.get',
            input: { v: 1, teamId: address.teamId },
            parse: value => TeamSummaryV1Schema.parse(value),
            signal: loadContext.signal,
        });
        if (loadContext.signal.aborted) return;
        if (result.kind === 'succeeded') {
            applyTeamProjection({
                scope,
                address,
                team: result.value,
                observedAt: Date.now(),
                current: loadContext.isCurrent(),
            });
            return;
        }
        applyTeamFailure({ scope, address, error: toSnapshotError(result.failure) });
    },
    shouldLoadOnObserve: ({ scope, address }) => {
        const current = getTeamSnapshot(scope, address);
        if (!current) return true;
        if (current.stale) return true;
        return current.data === null && current.status !== 'loading';
    },
    invalidateServer: (serverId) => {
        invalidateTeamsSnapshotsForServer(serverId);
    },
    invalidateTarget: ({ scope, address }) => {
        invalidateTeamSnapshot(scope, address);
    },
    matchesWake: (event) => event.entityIds === undefined
        || event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1),
});

/**
 * Directory keys currently fetching a continuation page. This guards only
 * pagination concurrency — a repeated scroll trigger must not request the same
 * page twice — and is not a second freshness policy.
 */
const paginating = new Set<string>();

export function observeTeamsDirectory(
    scope: ServerAccountScope,
    input: TeamsListInputV1,
): () => void {
    return loader.observe(targetFor(scope, input));
}

export async function refreshTeamsDirectory(
    scope: ServerAccountScope,
    input: TeamsListInputV1,
): Promise<void> {
    await loader.refresh(targetFor(scope, input));
}

/** Observes one immutable Team address under the exact Home Account scope. */
export function observeTeam(scope: ServerAccountScope, address: TeamAddress): () => void {
    const target = teamTargetFor(scope, address);
    return target ? teamLoader.observe(target) : () => {};
}

/** Explicitly retries one exact Team detail read. */
export async function refreshTeam(scope: ServerAccountScope, address: TeamAddress): Promise<void> {
    const target = teamTargetFor(scope, address);
    if (!target) return;
    await teamLoader.refresh(target);
}

/** An acknowledged membership change withdraws capabilities until the exact Team is revalidated. */
export async function invalidateTeam(scope: ServerAccountScope, address: TeamAddress): Promise<void> {
    const target = teamTargetFor(scope, address);
    if (!target) return;
    await teamLoader.invalidate(target);
}

/**
 * Continues the sequence. It is a no-op when the Home reported no further page
 * or when a continuation is already in flight.
 */
export async function loadMoreTeamsDirectory(
    scope: ServerAccountScope,
    input: TeamsListInputV1,
): Promise<void> {
    const target = targetFor(scope, input);
    const current = getTeamsDirectorySnapshot(scope, target.queryKey);
    const cursor = current?.nextCursor ?? null;
    if (!cursor || paginating.has(target.key)) return;

    paginating.add(target.key);
    try {
        await loader.readContinuation(target, async signal => {
            const result = await runTeamAction({ scope, actionId: 'teams.list', input: { ...input, cursor },
                parse: value => TeamsPageV1Schema.parse(value), signal });
            if (signal.aborted) return;
            // A refresh may have replaced this sequence, even when its cursor repeats.
            if ((getTeamsDirectorySnapshot(scope, target.queryKey)?.nextCursor ?? null) !== cursor) return;

            if (result.kind === 'succeeded') {
                applyTeamsDirectoryPage({
                    scope,
                    queryKey: target.queryKey,
                    items: result.value.items,
                    nextCursor: result.value.nextCursor,
                    observedAt: Date.now(),
                    append: true,
                });
                return;
            }
            applyTeamsDirectoryFailure({
                scope,
                queryKey: target.queryKey,
                error: toSnapshotError(result.failure),
            });
        });
    } finally {
        paginating.delete(target.key);
    }
}

/**
 * One Team roster sequence for its index, retained member rail and other visible
 * consumers. The scoped owner shares acquisition and preserves Account wakes;
 * unobserved searches retire just as the former component-local pager did.
 */
type TeamMembersTarget = ScopedLoadTarget & Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    filter: TeamMembersListFilterV1;
    query: string;
    queryKey: string;
}>;

function membersTargetFor(scope: ServerAccountScope, address: TeamAddress, filter: TeamMembersListFilterV1, query = ''): TeamMembersTarget | null {
    if (scope.serverId !== address.serverId) return null;
    const queryKey = teamMembersQueryKey(filter, query);
    return { key: teamMembersSnapshotKey(scope, address, queryKey),
        serverId: scope.serverId, scope, address, filter, query: query.trim(), queryKey };
}

const membersLoader = createScopedSnapshotLoader<TeamMembersTarget>({
    load: async ({ scope, address, filter, query, queryKey }, context) => {
        const loadedRowCount = getTeamMembersSnapshot(scope, address, queryKey)?.data?.length ?? 0;
        beginTeamMembersLoad(scope, address, queryKey);
        const begun = getTeamMembersSnapshot(scope, address, queryKey);
        const outcome = await loadTeamPageRange({ loadedRowCount,
            loadPage: cursor => listTeamMembers({ scope, address, filter, ...(query ? { query } : {}), cursor, signal: context.signal }),
            isCancelled: () => context.signal.aborted || getTeamMembersSnapshot(scope, address, queryKey) !== begun,
        });
        // Sign-out and the last observer retire this sequence while its request
        // may still be pending. Its old answer cannot recreate those private rows.
        if (!outcome || getTeamMembersSnapshot(scope, address, queryKey) !== begun) return;
        if (outcome.kind === 'succeeded') {
            applyTeamMembersPage({ scope, address, queryKey, ...outcome.value, current: context.isCurrent() });
        } else applyTeamMembersFailure({ scope, address, queryKey, error: outcome.failure });
    },
    shouldLoadOnObserve: ({ scope, address, queryKey }) => {
        const snapshot = getTeamMembersSnapshot(scope, address, queryKey);
        return !snapshot || snapshot.stale || (snapshot.data === null && snapshot.status !== 'loading');
    },
    invalidateServer: invalidateTeamsSnapshotsForServer,
    invalidateTarget: ({ scope, address, queryKey }, reason) => {
        if (reason === 'observer-gap') retireTeamMembersSnapshot(scope, address, queryKey);
        else invalidateTeamMembersSnapshot(scope, address, queryKey);
    },
    matchesWake: event => event.entityIds === undefined || event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1),
});

export function observeTeamMembers(scope: ServerAccountScope, address: TeamAddress, filter: TeamMembersListFilterV1, query?: string): () => void {
    const target = membersTargetFor(scope, address, filter, query);
    return target ? membersLoader.observe(target) : () => {};
}

export async function refreshTeamMembers(scope: ServerAccountScope, address: TeamAddress, filter: TeamMembersListFilterV1, query?: string): Promise<void> {
    const target = membersTargetFor(scope, address, filter, query);
    if (!target) return;
    const status = getTeamMembersSnapshot(scope, address, target.queryKey)?.status;
    // A read already at the Home predates this explicit refresh. Owe one
    // deciding pass, while same-turn refreshes before loading begins still join.
    if (status === 'loading' || status === 'loading_more') await membersLoader.invalidate(target);
    else await membersLoader.refresh(target);
}

export async function loadMoreTeamMembers(scope: ServerAccountScope, address: TeamAddress, filter: TeamMembersListFilterV1, query?: string): Promise<void> {
    const target = membersTargetFor(scope, address, filter, query);
    if (!target) return;
    const snapshot = getTeamMembersSnapshot(scope, address, target.queryKey);
    if (!snapshot?.nextCursor || snapshot.status === 'loading' || snapshot.status === 'loading_more') return;
    const cursor = snapshot.nextCursor;
    beginTeamMembersLoad(scope, address, target.queryKey, true);
    const pending = getTeamMembersSnapshot(scope, address, target.queryKey);
    await membersLoader.readContinuation(target, async signal => {
        const outcome = await listTeamMembers({ scope, address, filter, query: target.query, cursor, signal });
        // A refresh or wake replaces this snapshot even when its cursor repeats.
        // That older continuation can no longer append to the deciding sequence.
        if (signal.aborted || getTeamMembersSnapshot(scope, address, target.queryKey) !== pending) return;
        if (outcome.kind === 'succeeded') {
            applyTeamMembersPage({ scope, address, queryKey: target.queryKey, ...outcome.value, append: true, current: pending?.stale === false });
        } else applyTeamMembersFailure({ scope, address, queryKey: target.queryKey, error: outcome.failure });
    });
}

/** Shared Group labels retain their scoped snapshot beyond their visible list. */
type TeamGroupsTarget = ScopedLoadTarget & Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    archived: 'active' | 'archived';
    queryKey: string;
}>;

function groupsTargetFor(
    scope: ServerAccountScope,
    address: TeamAddress,
    archived: 'active' | 'archived',
): TeamGroupsTarget | null {
    if (scope.serverId !== address.serverId) return null;
    const queryKey = teamGroupsQueryKeyV1({ v: 1, teamId: address.teamId, archived });
    return {
        key: `${serverAccountScopedTeamKey(scope, address)}${queryKey.length}:${queryKey}`,
        serverId: scope.serverId,
        scope,
        address,
        archived,
        queryKey,
    };
}

const groupsLoader = createScopedSnapshotLoader<TeamGroupsTarget>({
    load: async ({ scope, address, archived, queryKey }, loadContext) => {
        const loadedRowCount = getTeamGroupsSnapshot(scope, address, queryKey)?.data?.length ?? 0;
        beginTeamGroupsLoad(scope, address, queryKey);
        const result = await loadTeamPageRange({
            loadedRowCount,
            loadPage: cursor => listTeamGroups({ scope, address, archived, cursor, signal: loadContext.signal }),
            isCancelled: () => loadContext.signal.aborted,
        });
        if (result === null) return;
        if (result.kind === 'succeeded') {
            applyTeamGroupsPage({
                scope,
                address,
                queryKey,
                items: result.value.items,
                nextCursor: result.value.nextCursor,
                observedAt: Date.now(),
                current: loadContext.isCurrent(),
            });
            return;
        }
        applyTeamGroupsFailure({ scope, address, queryKey, error: toSnapshotError(result.failure) });
    },
    shouldLoadOnObserve: ({ scope, address, queryKey }) => {
        const current = getTeamGroupsSnapshot(scope, address, queryKey);
        if (!current) return true;
        if (current.stale) return true;
        return current.data === null && current.status !== 'loading';
    },
    invalidateServer: (serverId) => {
        invalidateTeamsSnapshotsForServer(serverId);
    },
    invalidateTarget: ({ scope, address, queryKey }) => {
        invalidateTeamGroupsSnapshot(scope, address, queryKey);
    },
    matchesWake: (event) => event.entityIds === undefined
        || event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1),
});

type TeamGroupTarget = ScopedLoadTarget & Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    groupId: string;
}>;

function groupTargetFor(
    scope: ServerAccountScope,
    address: TeamAddress,
    groupId: string,
): TeamGroupTarget | null {
    if (scope.serverId !== address.serverId || groupId === '') return null;
    return {
        key: `${serverAccountScopedTeamKey(scope, address)}${groupId.length}:${groupId}`,
        serverId: scope.serverId,
        scope,
        address,
        groupId,
    };
}

const groupLoader = createScopedSnapshotLoader<TeamGroupTarget>({
    load: async ({ scope, address, groupId }, loadContext) => {
        beginTeamGroupLoad(scope, address, groupId);
        const result = await getTeamGroup({ scope, address, groupId, signal: loadContext.signal });
        if (loadContext.signal.aborted) return;
        if (result.kind === 'succeeded') {
            applyTeamGroupProjection({
                scope,
                address,
                group: result.value,
                observedAt: Date.now(),
                current: loadContext.isCurrent(),
            });
            return;
        }
        applyTeamGroupFailure({ scope, address, groupId, error: toSnapshotError(result.failure) });
    },
    shouldLoadOnObserve: ({ scope, address, groupId }) => {
        const current = getTeamGroupSnapshot(scope, address, groupId);
        if (!current) return true;
        if (current.stale) return true;
        return current.data === null && current.status !== 'loading';
    },
    invalidateServer: (serverId) => {
        invalidateTeamsSnapshotsForServer(serverId);
    },
    invalidateTarget: ({ scope, address, groupId }) => {
        invalidateTeamGroupSnapshot(scope, address, groupId);
    },
    matchesWake: (event) => event.entityIds === undefined
        || event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1),
});

type TeamCredentialResourcesTarget = ScopedLoadTarget & Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    search?: string;
    filter: TeamCredentialResourceListFilterV1;
    queryKey: string;
}>;

function credentialResourcesTargetFor(
    scope: ServerAccountScope,
    address: TeamAddress,
    search?: string,
    filter: TeamCredentialResourceListFilterV1 = 'all',
): TeamCredentialResourcesTarget | null {
    if (scope.serverId !== address.serverId) return null;
    const queryKey = search || filter !== 'all'
        ? teamCredentialResourcesQueryKeyV1({
            teamId: address.teamId,
            filter,
            ...(search ? { search } : {}),
        })
        : '';
    return {
        key: `credentials:${serverAccountScopedTeamKey(scope, address)}:${queryKey}`,
        serverId: scope.serverId,
        scope,
        address,
        filter,
        queryKey,
        ...(search ? { search } : {}),
    };
}

/**
 * One Team's shared credential resources.
 *
 * Like the directory and Group reads, acquisition uses the Team Action front
 * door so per-Action settings apply. The shared loader owns demand and freshness.
 */
const credentialResourcesLoader = createScopedSnapshotLoader<TeamCredentialResourcesTarget>({
    load: async ({ scope, address, search, filter, queryKey }, loadContext) => {
        beginTeamCredentialResourcesLoad(scope, address, queryKey);
        let outcome: Awaited<ReturnType<typeof listTeamCredentialResources>>;
        try {
            outcome = await listTeamCredentialResources({ scope, address, search, filter, signal: loadContext.signal });
        } catch {
            // Ask-first reads settle through the Action owner. A thrown fault
            // is not a Home answer and must not revive an abandoned observer.
            if (!loadContext.isCurrent()) return;
            applyTeamCredentialResourcesFailure({
                scope,
                address,
                queryKey,
                error: { kind: 'unknown', retryable: true },
            });
            return;
        }
        if (!loadContext.isCurrent()) return;
        if (outcome.kind === 'succeeded') {
            applyTeamCredentialResourcesPage({
                scope,
                address,
                queryKey,
                resources: outcome.value.resources,
                nextCursor: outcome.value.nextCursor,
                viewer: outcome.value.viewer,
                observedAt: Date.now(),
                current: loadContext.isCurrent(),
            });
            return;
        }
        const failure = outcome.failure;
        if (!failure) return;
        applyTeamCredentialResourcesFailure({
            scope,
            address,
            queryKey,
            error: toSnapshotError(failure),
        });
    },
    shouldLoadOnObserve: ({ scope, address, queryKey }) => {
        const current = getTeamCredentialResourcesSnapshot(scope, address, queryKey);
        if (!current) return true;
        if (current.stale) return true;
        return current.data === null && current.status !== 'loading';
    },
    invalidateServer: (serverId) => {
        invalidateTeamsSnapshotsForServer(serverId);
    },
    invalidateTarget: ({ scope, address, queryKey }) => {
        invalidateTeamCredentialResourcesSnapshot(scope, address, queryKey);
    },
    matchesWake: (event) => event.entityIds === undefined
        || event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1)
        || event.entityIds.includes(TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1),
});

type TeamCredentialResourceTarget = ScopedLoadTarget & Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    resourceId: string;
}>;

function credentialResourceTargetFor(
    scope: ServerAccountScope,
    address: TeamAddress,
    resourceId: string,
): TeamCredentialResourceTarget | null {
    if (scope.serverId !== address.serverId || resourceId === '') return null;
    return {
        key: `credential:${serverAccountScopedTeamKey(scope, address)}:${resourceId.length}:${resourceId}`,
        serverId: scope.serverId,
        scope,
        address,
        resourceId,
    };
}

/** One exact administration read for detail/editor/usage routes. */
const credentialResourceLoader = createScopedSnapshotLoader<TeamCredentialResourceTarget>({
    load: async ({ scope, address, resourceId }, loadContext) => {
        beginTeamCredentialResourceLoad(scope, address, resourceId);
        let outcome: Awaited<ReturnType<typeof getTeamCredentialResource>>;
        try {
            outcome = await getTeamCredentialResource({ scope, resourceId, signal: loadContext.signal });
        } catch {
            if (!loadContext.isCurrent()) return;
            applyTeamCredentialResourceFailure({
                scope,
                address,
                resourceId,
                error: { kind: 'unknown', retryable: true, code: null },
            });
            return;
        }
        if (!loadContext.isCurrent()) return;
        if (outcome.kind === 'succeeded') {
            // The Action is resource-addressed because the server owns its Team.
            // A route for another Team must still never adopt that valid row.
            if (outcome.value.teamId !== address.teamId || outcome.value.id !== resourceId) {
                applyTeamCredentialResourceFailure({
                    scope,
                    address,
                    resourceId,
                    error: { kind: 'forbidden', retryable: false, code: 'not_found_or_not_visible' },
                });
                return;
            }
            applyTeamCredentialResource({
                scope,
                address,
                resource: outcome.value,
                observedAt: Date.now(),
                current: loadContext.isCurrent(),
            });
            return;
        }
        applyTeamCredentialResourceFailure({
            scope,
            address,
            resourceId,
            error: toSnapshotError(outcome.failure),
        });
    },
    shouldLoadOnObserve: ({ scope, address, resourceId }) => {
        const current = getTeamCredentialResourceSnapshot(scope, address, resourceId);
        if (!current) return true;
        if (current.stale) return true;
        return current.data === null && current.status !== 'loading';
    },
    invalidateServer: (serverId) => {
        invalidateTeamsSnapshotsForServer(serverId);
    },
    invalidateTarget: ({ scope, address, resourceId }) => {
        invalidateTeamCredentialResourceSnapshot(scope, address, resourceId);
    },
    matchesWake: (event) => event.entityIds === undefined
        || event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1)
        || event.entityIds.includes(TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1),
});

type TeamCredentialResourceCatalogTarget = ScopedLoadTarget & Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    application?: ProviderBrokerApplicationBindingV1;
    executionMachineId?: string;
}>;

function credentialResourceCatalogTargetFor(
    scope: ServerAccountScope,
    address: TeamAddress,
    application?: ProviderBrokerApplicationBindingV1,
    executionMachineId?: string,
): TeamCredentialResourceCatalogTarget | null {
    if (scope.serverId !== address.serverId) return null;
    return {
        key: `credential-catalog:${teamCredentialResourceCatalogKey(scope, address, application, executionMachineId)}`,
        serverId: scope.serverId,
        scope,
        address,
        ...(application ? { application } : {}),
        ...(executionMachineId ? { executionMachineId } : {}),
    };
}

const credentialResourceCatalogLoader = createScopedSnapshotLoader<TeamCredentialResourceCatalogTarget>({
    loadGroupKey: ({ scope, application, executionMachineId }) => JSON.stringify([serverAccountScopeKeySuffix(scope), application ?? null, executionMachineId ?? null]),
    loadMany: async (loads, signal) => {
        const group = loads.filter(load => !load.context.signal.aborted);
        if (group.length === 0) return;
        for (const load of group) {
            const { scope, address, application, executionMachineId } = load.target;
            beginTeamCredentialResourceCatalogLoad(scope, address, application, executionMachineId);
        }
        const { scope, application, executionMachineId } = group[0]!.target;
        const teamIds = [...new Set(group.map(load => load.target.address.teamId))];
        const resourcesByTeam = new Map<string, TeamCredentialResourceCatalogEntryV1[]>();
        const failures = new Map<string, HomeDomainFailure>();
        let failure: HomeDomainFailure | undefined;
        let cursor: string | null = null;
        try {
            do {
                if (!group.some(load => load.context.isCurrent())) return;
                const outcome = await discoverEntitledTeamCredentialResources({ scope, teamIds,
                    signal,
                    ...(executionMachineId ? { executionMachineId } : {}),
                    shouldContinue: () => group.some(load => load.context.isCurrent()),
                    ...(application ? { application } : {}), ...(cursor ? { cursor } : {}) });
                if (outcome.kind === 'failed') {
                    failure = outcome.failure;
                    break;
                }
                for (const refusal of outcome.value.failures) {
                    failures.set(refusal.teamId, homeDomainFailureFromActionFailure({ errorCode: refusal.error },
                        'teams.credentials.entitled.list'));
                }
                for (const resource of outcome.value.resources) {
                    const resources = resourcesByTeam.get(resource.teamId);
                    if (resources) resources.push(resource);
                    else resourcesByTeam.set(resource.teamId, [resource]);
                }
                cursor = outcome.value.nextCursor;
            } while (cursor !== null);
        } catch {
            failure = { kind: 'unknown', retryable: true, code: null };
        }
        for (const { target: { address }, context } of group) {
            if (!context.isCurrent()) continue;
            // A later page failure cannot replace an already answered Team refusal.
            const refused = failures.get(address.teamId) ?? failure;
            if (refused) applyTeamCredentialResourceCatalogFailure({
                scope, address, application, executionMachineId, error: toSnapshotError(refused),
            });
            else applyTeamCredentialResourceCatalog({
                scope, address, application, executionMachineId, resources: resourcesByTeam.get(address.teamId) ?? [],
                observedAt: Date.now(), current: context.isCurrent(),
            });
        }
    },
    shouldLoadOnObserve: ({ scope, address, application, executionMachineId }) => {
        const current = getTeamCredentialResourceCatalogSnapshot(scope, address, application, executionMachineId);
        if (!current) return true;
        if (current.stale) return true;
        return current.data === null && current.status !== 'loading';
    },
    invalidateServer: (serverId) => {
        invalidateTeamsSnapshotsForServer(serverId);
    },
    invalidateTarget: ({ scope, address, application, executionMachineId }, reason) => {
        invalidateTeamCredentialResourceCatalog(scope, address, application, { retainSelection: reason === 'reload' }, executionMachineId);
    },
    matchesWake: (event) => event.entityIds === undefined
        || event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1)
        || event.entityIds.includes(TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1),
});

/** Observes one Team's shared credential resources under its exact Home Account scope. */
export function observeTeamCredentialResources(
    scope: ServerAccountScope,
    address: TeamAddress,
    search?: string,
    filter: TeamCredentialResourceListFilterV1 = 'all',
): () => void {
    const target = credentialResourcesTargetFor(scope, address, search, filter);
    return target ? credentialResourcesLoader.observe(target) : () => {};
}

/** Observes one exact resource without making detail routes own list pagination. */
export function observeTeamCredentialResource(
    scope: ServerAccountScope,
    address: TeamAddress,
    resourceId: string,
): () => void {
    const target = credentialResourceTargetFor(scope, address, resourceId);
    return target ? credentialResourceLoader.observe(target) : () => {};
}

/** Explicitly retries one exact resource administration read. */
export async function refreshTeamCredentialResource(
    scope: ServerAccountScope,
    address: TeamAddress,
    resourceId: string,
): Promise<void> {
    const target = credentialResourceTargetFor(scope, address, resourceId);
    if (!target) return;
    await credentialResourceLoader.refresh(target);
}

/** Observes a filter-independent recipient catalog for an exact Team/application. */
export function observeTeamCredentialResourceCatalog(
    scope: ServerAccountScope,
    address: TeamAddress,
    application?: ProviderBrokerApplicationBindingV1,
    executionMachineId?: string,
): () => void {
    const target = credentialResourceCatalogTargetFor(scope, address, application, executionMachineId);
    return target ? credentialResourceCatalogLoader.observe(target) : () => {};
}

/** Explicitly retries only the recipient catalog, without taking list ownership. */
export async function refreshTeamCredentialResourceCatalog(
    scope: ServerAccountScope,
    address: TeamAddress,
    application?: ProviderBrokerApplicationBindingV1,
    executionMachineId?: string,
): Promise<void> {
    const target = credentialResourceCatalogTargetFor(scope, address, application, executionMachineId);
    if (!target) return;
    await credentialResourceCatalogLoader.refresh(target);
}

/** Explicitly re-reads one Team's shared credential resources. */
export async function refreshTeamCredentialResources(
    scope: ServerAccountScope,
    address: TeamAddress,
    search?: string,
    filter: TeamCredentialResourceListFilterV1 = 'all',
): Promise<void> {
    const target = credentialResourcesTargetFor(scope, address, search, filter);
    if (target) await credentialResourcesLoader.refresh(target);
}

/** Continues the resource sequence without discarding pages already shown. */
export async function loadMoreTeamCredentialResources(
    scope: ServerAccountScope,
    address: TeamAddress,
    search?: string,
    filter: TeamCredentialResourceListFilterV1 = 'all',
): Promise<void> {
    const target = credentialResourcesTargetFor(scope, address, search, filter);
    if (!target) return;
    const cursor = getTeamCredentialResourcesSnapshot(scope, address, target.queryKey)?.nextCursor ?? null;
    if (!cursor || paginating.has(target.key)) return;

    paginating.add(target.key);
    try {
        await credentialResourcesLoader.readContinuation(target, async signal => {
            const outcome = await listTeamCredentialResources({ scope, address, cursor, search, filter, signal });
            if (signal.aborted) return;
            if ((getTeamCredentialResourcesSnapshot(scope, address, target.queryKey)?.nextCursor ?? null) !== cursor) return;
            if (outcome.kind === 'succeeded') {
                const current = getTeamCredentialResourcesSnapshot(scope, address, target.queryKey);
                applyTeamCredentialResourcesPage({
                    scope,
                    address,
                    queryKey: target.queryKey,
                    resources: outcome.value.resources,
                    nextCursor: outcome.value.nextCursor,
                    viewer: outcome.value.viewer,
                    observedAt: Date.now(),
                    append: true,
                    current: current?.stale === false,
                });
                return;
            }
            applyTeamCredentialResourcesFailure({
                scope,
                address,
                queryKey: target.queryKey,
                error: toSnapshotError(outcome.failure),
            });
        });
    } finally {
        paginating.delete(target.key);
    }
}

/** Observes one Team's Groups for one archive filter under the exact Home Account scope. */
export function observeTeamGroups(
    scope: ServerAccountScope,
    address: TeamAddress,
    archived: 'active' | 'archived',
): () => void {
    const target = groupsTargetFor(scope, address, archived);
    return target ? groupsLoader.observe(target) : () => {};
}

/** Explicitly revalidates one Team's loaded Groups range from its first page. */
export async function refreshTeamGroups(
    scope: ServerAccountScope,
    address: TeamAddress,
    archived: 'active' | 'archived',
): Promise<void> {
    const target = groupsTargetFor(scope, address, archived);
    if (!target) return;
    await groupsLoader.refresh(target);
}

/** Observes one exact Group under the Home, Account and Team that own it. */
export function observeTeamGroup(
    scope: ServerAccountScope,
    address: TeamAddress,
    groupId: string,
): () => void {
    const target = groupTargetFor(scope, address, groupId);
    return target ? groupLoader.observe(target) : () => {};
}

/** Explicitly retries one exact Group detail read. */
export async function refreshTeamGroup(
    scope: ServerAccountScope,
    address: TeamAddress,
    groupId: string,
): Promise<void> {
    const target = groupTargetFor(scope, address, groupId);
    if (!target) return;
    await groupLoader.refresh(target);
}

/**
 * Continues the Groups sequence, with the same position check the Team directory
 * uses: a refresh may have replaced the sequence while this page was in flight,
 * and appending a page that continues a position the list has left would
 * duplicate rows and hand the reader a cursor into a sequence that is gone.
 */
export async function loadMoreTeamGroups(
    scope: ServerAccountScope,
    address: TeamAddress,
    archived: 'active' | 'archived',
): Promise<void> {
    const target = groupsTargetFor(scope, address, archived);
    if (!target) return;
    const cursor = getTeamGroupsSnapshot(scope, address, target.queryKey)?.nextCursor ?? null;
    if (!cursor || paginating.has(target.key)) return;

    paginating.add(target.key);
    try {
        await groupsLoader.readContinuation(target, async signal => {
            const result = await listTeamGroups({ scope, address, archived, cursor, signal });
            if (signal.aborted) return;
            if ((getTeamGroupsSnapshot(scope, address, target.queryKey)?.nextCursor ?? null) !== cursor) return;

            if (result.kind === 'succeeded') {
                applyTeamGroupsPage({
                    scope,
                    address,
                    queryKey: target.queryKey,
                    items: result.value.items,
                    nextCursor: result.value.nextCursor,
                    observedAt: Date.now(),
                    append: true,
                });
                return;
            }
            applyTeamGroupsFailure({
                scope,
                address,
                queryKey: target.queryKey,
                error: toSnapshotError(result.failure),
            });
        });
    } finally {
        paginating.delete(target.key);
    }
}

/** Test-only reset of the engine's observation, single-flight and paging state. */
export function resetTeamsDirectoryEngineForTests(): void {
    loader.resetForTests();
    teamLoader.resetForTests();
    groupsLoader.resetForTests();
    membersLoader.resetForTests();
    groupLoader.resetForTests();
    credentialResourcesLoader.resetForTests();
    credentialResourceLoader.resetForTests();
    credentialResourceCatalogLoader.resetForTests();
    paginating.clear();
}
