import {
    TeamGroupV1Schema,
    TeamGroupsPageV1Schema,
    TeamsPageV1Schema,
    TeamSummaryV1Schema,
    teamDirectoryQueryKeyV1,
    teamCredentialResourcesQueryKeyV1,
    teamGroupsQueryKeyV1,
    type TeamCredentialResourceListFilterV1,
    type TeamsListInputV1,
} from '@happier-dev/protocol/teams';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';

import {
    requestHomeDomain,
    type HomeDomainFailure,
} from '@/sync/api/home/homeServerActionTransport';
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
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    getTeamCredentialResource,
    listEntitledTeamCredentialResources,
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
        const request = bindHomeDomainActionHttpRequestV1('teams.list', { ...input, cursor: null });
        const result = await requestHomeDomain({
            scope,
            method: request.method,
            path: request.path,
            effect: 'read',
            input: request.body,
            schema: TeamsPageV1Schema,
        });
        if (result.ok) {
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
        const request = bindHomeDomainActionHttpRequestV1('teams.get', { v: 1, teamId: address.teamId });
        const result = await requestHomeDomain({
            scope,
            method: request.method,
            path: request.path,
            effect: 'read',
            input: request.body,
            schema: TeamSummaryV1Schema,
        });
        if (result.ok) {
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
        const request = bindHomeDomainActionHttpRequestV1('teams.list', { ...input, cursor });
        const result = await requestHomeDomain({
            scope,
            method: request.method,
            path: request.path,
            effect: 'read',
            input: request.body,
            schema: TeamsPageV1Schema,
        });
        // A refresh may have replaced the whole sequence while this page was in
        // flight — a wake re-reads page one, and it can land first. The cursor
        // *is* the position in a sequence, so a directory that no longer sits at
        // the position this page continues has moved on, and appending it would
        // duplicate rows the refresh already published and hand the reader a
        // cursor into a sequence that no longer exists. Dropping the answer is
        // correct and loses nothing: the fresh page carries its own cursor.
        if ((getTeamsDirectorySnapshot(scope, target.queryKey)?.nextCursor ?? null) !== cursor) return;

        if (result.ok) {
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
    } finally {
        paginating.delete(target.key);
    }
}

/**
 * One Team's Groups, on the same scoped-snapshot lifetime as the Team directory.
 *
 * Groups were previously read by a component-local paged list, which meant each
 * mounted surface held its own pages, no Account-change wake reached them, and
 * nothing retired them with their credential. They now share this owner, so a
 * Group label is readable synchronously by any surface — session rows, Activity,
 * Inbox and notification context — from one subscription rather than one
 * subscription per card.
 */
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
        beginTeamGroupsLoad(scope, address, queryKey);
        // A refresh always re-reads the first page, for the same reason the Team
        // directory does: a cursor names a position in a sequence that may have
        // moved, and replaying it would duplicate rows.
        const request = bindHomeDomainActionHttpRequestV1('teams.groups.list', {
            v: 1,
            teamId: address.teamId,
            archived,
        });
        const result = await requestHomeDomain({
            scope,
            method: request.method,
            path: request.path,
            effect: 'read',
            input: request.body,
            schema: TeamGroupsPageV1Schema,
        });
        if (result.ok) {
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
        const request = bindHomeDomainActionHttpRequestV1('teams.groups.get', {
            v: 1,
            teamId: address.teamId,
            groupId,
        });
        const result = await requestHomeDomain({
            scope,
            method: request.method,
            path: request.path,
            effect: 'read',
            input: request.body,
            schema: TeamGroupV1Schema,
        });
        if (result.ok) {
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
 * Unlike the directory and Group reads beside it, this one goes through the
 * Team Action front door rather than the raw Home transport: the resource
 * intents are declared Actions, and a read that bypassed the front door would
 * escape the per-surface enablement and provenance every other resource intent
 * is subject to. The freshness lifecycle is still the shared one, so the
 * projection cannot develop a second refresh policy.
 */
const credentialResourcesLoader = createScopedSnapshotLoader<TeamCredentialResourcesTarget>({
    load: async ({ scope, address, search, filter, queryKey }, loadContext) => {
        beginTeamCredentialResourcesLoad(scope, address, queryKey);
        let outcome: Awaited<ReturnType<typeof listTeamCredentialResources>>;
        try {
            outcome = await listTeamCredentialResources({ scope, address, search, filter });
        } catch {
            // A read is never dangerous, so the front door has no approval to
            // defer here; anything thrown is a transport fault, not an answer.
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
        || event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1),
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
            outcome = await getTeamCredentialResource({ scope, resourceId });
        } catch {
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
        || event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1),
});

type TeamCredentialResourceCatalogTarget = ScopedLoadTarget & Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
}>;

function readRecipientCatalogNextCursor(page: object): string | null {
    if (!('nextCursor' in page)) return null;
    return typeof page.nextCursor === 'string' ? page.nextCursor : null;
}

function credentialResourceCatalogTargetFor(
    scope: ServerAccountScope,
    address: TeamAddress,
): TeamCredentialResourceCatalogTarget | null {
    if (scope.serverId !== address.serverId) return null;
    return {
        key: `credential-catalog:${serverAccountScopedTeamKey(scope, address)}`,
        serverId: scope.serverId,
        scope,
        address,
    };
}

const credentialResourceCatalogLoader = createScopedSnapshotLoader<TeamCredentialResourceCatalogTarget>({
    load: async ({ scope, address }, loadContext) => {
        beginTeamCredentialResourceCatalogLoad(scope, address);
        let outcome: Awaited<ReturnType<typeof listEntitledTeamCredentialResources>>;
        try {
            outcome = await listEntitledTeamCredentialResources({ scope, address });
        } catch {
            applyTeamCredentialResourceCatalogFailure({
                scope,
                address,
                error: { kind: 'unknown', retryable: true },
            });
            return;
        }
        if (!loadContext.isCurrent()) return;
        if (outcome.kind === 'succeeded') {
            const resources = [...outcome.value.resources];
            let cursor = readRecipientCatalogNextCursor(outcome.value);
            while (cursor && loadContext.isCurrent()) {
                const continuation = await listEntitledTeamCredentialResources({ scope, address, cursor });
                if (continuation.kind !== 'succeeded') {
                    applyTeamCredentialResourceCatalogFailure({
                        scope, address, error: toSnapshotError(continuation.failure),
                    });
                    return;
                }
                resources.push(...continuation.value.resources);
                cursor = readRecipientCatalogNextCursor(continuation.value);
            }
            if (!loadContext.isCurrent()) return;
            applyTeamCredentialResourceCatalog({
                scope,
                address,
                resources,
                observedAt: Date.now(),
                current: loadContext.isCurrent(),
            });
            return;
        }
        applyTeamCredentialResourceCatalogFailure({
            scope,
            address,
            error: toSnapshotError(outcome.failure),
        });
    },
    shouldLoadOnObserve: ({ scope, address }) => {
        const current = getTeamCredentialResourceCatalogSnapshot(scope, address);
        if (!current) return true;
        if (current.stale) return true;
        return current.data === null && current.status !== 'loading';
    },
    invalidateServer: (serverId) => {
        invalidateTeamsSnapshotsForServer(serverId);
    },
    invalidateTarget: ({ scope, address }) => {
        invalidateTeamCredentialResourceCatalog(scope, address);
    },
    matchesWake: (event) => event.entityIds === undefined
        || event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1),
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

/** Observes the filter-independent recipient catalog once for an exact Team. */
export function observeTeamCredentialResourceCatalog(
    scope: ServerAccountScope,
    address: TeamAddress,
): () => void {
    const target = credentialResourceCatalogTargetFor(scope, address);
    return target ? credentialResourceCatalogLoader.observe(target) : () => {};
}

/** Explicitly retries only the recipient catalog, without taking list ownership. */
export async function refreshTeamCredentialResourceCatalog(
    scope: ServerAccountScope,
    address: TeamAddress,
): Promise<void> {
    const target = credentialResourceCatalogTargetFor(scope, address);
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
    const catalogTarget = credentialResourceCatalogTargetFor(scope, address);
    await Promise.all([
        target ? credentialResourcesLoader.refresh(target) : Promise.resolve(),
        catalogTarget ? credentialResourceCatalogLoader.refresh(catalogTarget) : Promise.resolve(),
    ]);
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
        const outcome = await listTeamCredentialResources({ scope, address, cursor, search, filter });
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

/** Explicitly re-reads one Team's Groups sequence from its first page. */
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
        const request = bindHomeDomainActionHttpRequestV1('teams.groups.list', {
            v: 1,
            teamId: address.teamId,
            archived,
            cursor,
        });
        const result = await requestHomeDomain({
            scope,
            method: request.method,
            path: request.path,
            effect: 'read',
            input: request.body,
            schema: TeamGroupsPageV1Schema,
        });
        if ((getTeamGroupsSnapshot(scope, address, target.queryKey)?.nextCursor ?? null) !== cursor) return;

        if (result.ok) {
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
    } finally {
        paginating.delete(target.key);
    }
}

/** Test-only reset of the engine's observation, single-flight and paging state. */
export function resetTeamsDirectoryEngineForTests(): void {
    loader.resetForTests();
    teamLoader.resetForTests();
    groupsLoader.resetForTests();
    groupLoader.resetForTests();
    credentialResourcesLoader.resetForTests();
    credentialResourceLoader.resetForTests();
    credentialResourceCatalogLoader.resetForTests();
    paginating.clear();
}
