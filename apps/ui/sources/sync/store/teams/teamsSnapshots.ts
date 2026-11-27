import {
    teamDirectoryQueryKeyV1,
    teamGroupsQueryKeyV1,
    type TeamMembersListFilterV1,
    type TeamMembershipV1,
    type TeamCredentialResourceCatalogEntryV1,
    type TeamCredentialExternalApiKeySummaryV1,
    type TeamCredentialSourceResourceAdministrationV1,
    type TeamCredentialSourceCandidateListOutputV1,
    type TeamCredentialResourceActivityEventV1,
    type TeamCredentialUsageQueryResultV1,
    type TeamCredentialUsageLimitV1,
    type TeamCredentialResourceSummaryV1,
    type TeamCredentialViewerCapabilitiesV1,
    type TeamGroupV1,
    type TeamGroupMemberV1,
    type TeamInvitationRowV1,
    type TeamDirectoryGroupPageV1,
    type TeamDirectoryPeoplePageV1,
    type TeamDirectorySourceSummaryV1,
    type TeamExternalGroupBindingV1,
    type TeamSummaryV1,
    type TeamSharedResourceSummaryRowV1,
} from '@happier-dev/protocol/teams';
import { teamSharedResourceSummaryRowKeyV1 } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';
import type { ProviderBrokerApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';
import type { HomeDomainFailure } from '@/sync/ops/teams/teamActionClient';
import type { ManagedMachinePresetListEntryV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import type { TeamSharedMachineListItem } from '@/sync/ops/teams/teamSharedMachines';
import type { TeamPage } from '@/sync/engine/teams/loadTeamPageRange';
import type { SavedSecretCatalogResultV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { ArtifactActionResultV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { ReviewListResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import { snapshotReferenceSelectionKey } from '@/sync/domains/scope/snapshotReferenceSelectionKey';
import { managedIdentityQueryKey } from '@/sync/store/home/governance/homeGovernanceSnapshots';
import { CredentialCatalogPublication } from './credentialCatalogPublication';
import { areSnapshotProjectionsEquivalent as areProjectionsEquivalent, retainKeyedRows } from '@/sync/domains/state/structuralSharing';

import {
    readServerAccountScopeOwnerLifetime,
    serverAccountScopeKeySuffix,
    serverAccountScopedResourceKey,
    type ServerAccountScope,
    type ServerAccountScopeLifetime,
} from '@/sync/domains/scope/serverAccountScope';
import {
    serverAccountScopedTeamKey,
    serverAccountScopedTeamResourceKey,
    teamSetupStepId,
    type TeamAddress,
} from '@/sync/domains/teams/teamAddress';
import {
    isAuthoritativeScopedSnapshotRefusal,
    isAuthoritativeScopedSnapshotRefusalKind,
    reachabilityForScopedSnapshotError,
    type ScopedSnapshotError,
    type ScopedSnapshotReachability,
    type ScopedSnapshotStatus,
} from '@/sync/domains/scope/scopedSnapshotFacts';

/**
 * Server-Account-qualified Team directory, Team detail and Team Group snapshots.
 *
 * Every row is keyed by `ServerAccountScope`, and Team detail additionally by
 * `TeamAddress`: two Homes may legitimately hold the same Team ID, and two
 * Accounts on one Home see different Teams, roles and capabilities. Neither may
 * ever read the other's rows.
 *
 * The projections are fully reconstructible from their Home, so invalidation
 * only marks rows stale. There is no Team cursor, event replay, polling timer or
 * global active-Team state here.
 */

export type TeamsDirectorySnapshot = Readonly<{
    scope: ServerAccountScope;
    /** The protocol's own query identity, so no second keying rule exists. */
    queryKey: string;
    status: ScopedSnapshotStatus;
    /** Accumulated pages in server order. Retained across refresh and failure. */
    data: readonly TeamSummaryV1[] | null;
    nextCursor: string | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

/**
 * One Team's Groups for one archive filter.
 *
 * Groups are keyed by the full `ServerAccountScope` plus `TeamAddress` plus the
 * protocol's own query identity, because every one of those can legitimately
 * repeat: two Homes hold the same Team ID, two Accounts on one Home see
 * different Groups, and active and archived are separate sequences with
 * separate orderings.
 */
export type TeamGroupsSnapshot = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    /** The protocol's own query identity, so no second keying rule exists. */
    queryKey: string;
    status: ScopedSnapshotStatus;
    /** Accumulated pages in server order. Retained across refresh and failure. */
    data: readonly TeamGroupV1[] | null;
    nextCursor: string | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

/** One exact Team/filter/lookup sequence shared by its visible roster consumers. */
export type TeamMembersSnapshot = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    queryKey: string;
    status: Exclude<ScopedSnapshotStatus, 'refreshing'> | 'loading_more';
    data: readonly TeamMembershipV1[] | null;
    nextCursor: string | null;
    stale: boolean;
    error: HomeDomainFailure | null;
}>;

export function teamMembersQueryKey(filter: TeamMembersListFilterV1, query = ''): string {
    return JSON.stringify([filter, query.trim()]);
}

export function teamMembersSnapshotKey(scope: ServerAccountScope, address: TeamAddress, queryKey: string): string {
    return serverAccountScopedTeamResourceKey(scope, address, 'members', queryKey);
}

export type TeamGroupSnapshot = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    groupId: string;
    status: ScopedSnapshotStatus;
    data: TeamGroupV1 | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

export type TeamSnapshot = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    status: ScopedSnapshotStatus;
    data: TeamSummaryV1 | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

/**
 * One Team's shared credential resources as this exact viewer sees them.
 *
 * The Home decides the administration rows and management capabilities in one
 * read, so those facts remain together. The filter-independent recipient
 * catalog is a separate authority answer retained below.
 *
 * Pages accumulate in the Home's stable order. A failed continuation keeps
 * both the rows and cursor so retry resumes the exact sequence position.
 */
export type TeamCredentialResourcesSnapshot = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    /** The protocol list query represented by this retained sequence. */
    queryKey: string;
    status: ScopedSnapshotStatus;
    /** Retained across refresh and failure so a list never blanks. */
    data: readonly TeamCredentialResourceSummaryV1[] | null;
    nextCursor: string | null;
    viewer: TeamCredentialViewerCapabilitiesV1 | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

export type TeamSharedResourcesSummarySnapshot = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    lifetime: ServerAccountScopeLifetime;
    data: readonly TeamSharedResourceSummaryRowV1[] | null;
    status: 'loading' | 'ready' | 'error';
    error: HomeDomainFailure | null;
}>;

/**
 * Recipient-safe credential choices for one exact Home Account, Team and optional application.
 *
 * This is deliberately independent of administration list query identity:
 * changing a manager's search/filter must not reopen the same entitlement
 * read, and an entitlement outage must not blank otherwise usable admin rows.
 */
export type TeamCredentialResourceCatalogSnapshot = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    application?: ProviderBrokerApplicationBindingV1;
    executionMachineId?: string;
    status: ScopedSnapshotStatus;
    data: readonly TeamCredentialResourceCatalogEntryV1[] | null;
    lastObservedAt: number | null;
    stale: boolean;
    /** Last admitted picker choices survive advisory rereads, never grant launch authority. */
    selectionCurrent: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

/** One exact administration resource under its full Home/Account/Team scope. */
export type TeamCredentialResourceSnapshot = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    resourceId: string;
    status: ScopedSnapshotStatus;
    /** Retained across a transient refresh failure; withdrawn on a settled refusal. */
    data: TeamCredentialResourceSummaryV1 | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

const directories = new Map<string, TeamsDirectorySnapshot>();
const teams = new Map<string, TeamSnapshot>();
const groupLists = new Map<string, TeamGroupsSnapshot>();
const memberLists = new Map<string, TeamMembersSnapshot>();
const groups = new Map<string, TeamGroupSnapshot>();
const credentialLists = new Map<string, TeamCredentialResourcesSnapshot>();
const credentialCatalogs = new CredentialCatalogPublication();
const credentialResources = new Map<string, TeamCredentialResourceSnapshot>();
const sharedResourceSummaries = new Map<string, TeamSharedResourcesSummarySnapshot>();

/** Retained Team-filtered observations have their own query and credential lifetime. */
function createTeamObservations<Data>() {
    const observations = new Map<string, Readonly<{
        data: Data;
        lifetime: ServerAccountScopeLifetime;
    }>>();
    return {
        get(key: string) {
            const observation = observations.get(key);
            return observation?.lifetime.isCurrent() ? observation.data : undefined;
        },
        findForTeam<T>(scope: ServerAccountScope, address: TeamAddress, find: (data: Data) => T | undefined): T | undefined {
            const prefix = serverAccountScopedTeamKey(scope, address);
            for (const [key, { data, lifetime }] of observations) {
                if (key.startsWith(prefix) && lifetime.scope.serverId === scope.serverId
                    && lifetime.scope.accountId === scope.accountId && lifetime.isCurrent()) {
                    const match = find(data);
                    if (match !== undefined) return match;
                }
            }
        },
        apply(key: string, lifetime: ServerAccountScopeLifetime, data: Data | null) {
            if (!lifetime.isCurrent()) return;
            if (data === null) observations.delete(key);
            else observations.set(key, { data, lifetime: readServerAccountScopeOwnerLifetime(lifetime) });
        },
        clearForServer(serverId: string) {
            for (const [key, observation] of observations) {
                if (observation.lifetime.scope.serverId === serverId) observations.delete(key);
            }
        },
        clear: () => observations.clear(),
    };
}

export const teamSharedMachineObservations = createTeamObservations<readonly TeamSharedMachineListItem[]>();
export const teamSharedMachinePoolObservations = createTeamObservations<readonly MachinePoolViewV1[]>();
export type TeamSharedMachinePresetRow = Readonly<Pick<ManagedMachinePresetListEntryV1, 'id' | 'name'>>;
export const teamSharedMachinePresetPages = createTeamObservations<TeamPage<TeamSharedMachinePresetRow>>();
export const teamSharedSavedSecretPages = createTeamObservations<TeamPage<SavedSecretCatalogResultV1>>();
export type TeamSharedArtifactRow = ArtifactActionResultV1<'artifact.list'>['items'][number] & Readonly<{
    review?: ReviewListResponseV1['items'][number];
}>;
export const teamSharedArtifactPages = createTeamObservations<TeamPage<TeamSharedArtifactRow>>();
export const teamSharedDiscussionPages = createTeamObservations<TeamPage<DiscussionOpenedSummaryV1>>();
export const teamDirectorySourcePages = createTeamObservations<TeamPage<TeamDirectorySourceSummaryV1>>();

export function readTeamDirectorySourceName(scope: ServerAccountScope, teamId: string, sourceId: string): string | null {
    return teamDirectorySourcePages.get(managedIdentityQueryKey(scope, teamId))?.items
        .find(source => source.id === sourceId && source.teamId === teamId)?.displayName ?? null;
}

export const teamInvitationPages = createTeamObservations<TeamPage<TeamInvitationRowV1>>();
export const teamCredentialExternalApiKeyObservations = createTeamObservations<readonly TeamCredentialExternalApiKeySummaryV1[]>();
export function teamCredentialExternalKeyObservationKey(scope: ServerAccountScope, address: TeamAddress, resourceId: string): string {
    return serverAccountScopedTeamResourceKey(scope, address, 'credential-external-api-keys', resourceId);
}

export function readObservedTeamCredentialExternalKey(
    scope: ServerAccountScope, teamId: string, resourceId: string, keyId: string,
): TeamCredentialExternalApiKeySummaryV1 | undefined {
    const key = teamCredentialExternalKeyObservationKey(scope, { serverId: scope.serverId, teamId }, resourceId);
    return teamCredentialExternalApiKeyObservations.get(key)?.find(row => row.resourceId === resourceId && row.keyId === keyId);
}

export const teamCredentialUsageObservations = createTeamObservations<TeamCredentialUsageQueryResultV1>();
export const teamCredentialLimitObservations = createTeamObservations<Readonly<{
    resourceRevision: number;
    limits: readonly TeamCredentialUsageLimitV1[];
}>>();

export function teamCredentialLimitsObservationKey(scope: ServerAccountScope, resourceId: string): string {
    return serverAccountScopedResourceKey(scope, 'team-credential-limits', resourceId);
}

export function readObservedTeamCredentialLimit(
    scope: ServerAccountScope, resourceId: string, resourceRevision: number, limitId: string,
): TeamCredentialUsageLimitV1 | undefined {
    const observation = teamCredentialLimitObservations.get(teamCredentialLimitsObservationKey(scope, resourceId));
    return observation?.resourceRevision === resourceRevision ? observation.limits.find(row => row.id === limitId) : undefined;
}
export const teamGroupMemberPages = createTeamObservations<TeamPage<TeamGroupMemberV1>>();
export const teamMemberGroupPages = createTeamObservations<TeamPage<TeamGroupV1>>();
export const teamCredentialActivityPages = createTeamObservations<TeamPage<TeamCredentialResourceActivityEventV1>>();
export const teamCredentialSourceResourcePages = createTeamObservations<TeamPage<TeamCredentialSourceResourceAdministrationV1>>();
export const teamCredentialSourceCandidateObservations = createTeamObservations<TeamCredentialSourceCandidateListOutputV1>();
export const teamDirectoryPeoplePages = createTeamObservations<TeamPage<TeamDirectoryPeoplePageV1['items'][number]>>();
export const teamDirectoryGroupPages = createTeamObservations<TeamPage<TeamDirectoryGroupPageV1['items'][number]>>();
export const teamExternalGroupBindingPages = createTeamObservations<TeamPage<TeamExternalGroupBindingV1>>();

export function teamDirectoryGroupObservationKey(scope: ServerAccountScope, address: TeamAddress, sourceId: string, filter: string): string {
    return serverAccountScopedTeamResourceKey(scope, address, 'directory-groups', sourceId, filter);
}

export function readTeamDirectoryGroupName(scope: ServerAccountScope, teamId: string, sourceId: string, externalGroupId: string): string | null {
    const key = teamDirectoryGroupObservationKey(scope, { serverId: scope.serverId, teamId }, sourceId, '');
    return teamDirectoryGroupPages.get(key)?.items
        .find(group => group.sourceId === sourceId && group.externalGroupId === externalGroupId)?.displayName ?? null;
}

export function readObservedTeamExternalGroupBinding(scope: ServerAccountScope, teamId: string, bindingId: string) {
    const address = { serverId: scope.serverId, teamId };
    const directoryGroup = teamDirectoryGroupPages.findForTeam(scope, address, page =>
        page.items.find(group => group.mapping.state === 'bound' && group.mapping.bindingId === bindingId));
    if (directoryGroup) return { kind: 'directoryGroup' as const, displayName: directoryGroup.displayName };
    const binding = teamExternalGroupBindingPages.findForTeam(scope, address, page =>
        page.items.find(row => row.teamId === teamId && row.id === bindingId));
    return binding ? { kind: 'teamGroup' as const, target: binding.target } : null;
}
const retainedTeamObservations = [
    teamSharedMachineObservations,
    teamSharedMachinePoolObservations,
    teamSharedMachinePresetPages,
    teamSharedSavedSecretPages,
    teamSharedArtifactPages,
    teamSharedDiscussionPages,
    teamDirectorySourcePages,
    teamInvitationPages,
    teamCredentialExternalApiKeyObservations,
    teamCredentialUsageObservations,
    teamCredentialLimitObservations,
    teamGroupMemberPages,
    teamMemberGroupPages,
    teamCredentialActivityPages,
    teamCredentialSourceResourcePages,
    teamCredentialSourceCandidateObservations,
    teamDirectoryPeoplePages,
    teamDirectoryGroupPages,
    teamExternalGroupBindingPages,
];
const listeners = new Set<() => void>();
type TeamsSnapshotSlice = 'directory' | 'team' | 'groups' | 'members'
    | 'credentialResources' | 'credentialCatalog' | 'sharedResources';
const sliceListeners = new Map<string, Set<() => void>>();

function sliceKey(scope: ServerAccountScope, slice: TeamsSnapshotSlice): string {
    return `${serverAccountScopeKeySuffix(scope)}${slice}`;
}

function notify(keys: readonly string[] = []): void {
    credentialCatalogs.flush();
    const selected = new Set(listeners);
    for (const key of keys) for (const listener of sliceListeners.get(key) ?? []) selected.add(listener);
    for (const listener of selected) {
        try {
            listener();
        } catch {
            // One subscriber cannot prevent its siblings from observing.
        }
    }
}

function directoryKey(scope: ServerAccountScope, queryKey: string): string {
    return `${serverAccountScopeKeySuffix(scope)}${queryKey.length}:${queryKey}`;
}

function groupListKey(scope: ServerAccountScope, address: TeamAddress, queryKey: string): string {
    return `${serverAccountScopedTeamKey(scope, address)}${queryKey.length}:${queryKey}`;
}

function groupKey(scope: ServerAccountScope, address: TeamAddress, groupId: string): string {
    return `${serverAccountScopedTeamKey(scope, address)}${groupId.length}:${groupId}`;
}

function credentialListKey(scope: ServerAccountScope, address: TeamAddress, queryKey: string): string {
    return `${serverAccountScopedTeamKey(scope, address)}${queryKey.length}:${queryKey}`;
}

function credentialResourceKey(scope: ServerAccountScope, address: TeamAddress, resourceId: string): string {
    return `${serverAccountScopedTeamKey(scope, address)}${resourceId.length}:${resourceId}`;
}

function sharedResourceSummaryKey(scope: ServerAccountScope, address: TeamAddress): string {
    return serverAccountScopedTeamKey(scope, address);
}

function credentialSnapshotMatches(
    snapshot: Readonly<{ scope: ServerAccountScope; address: TeamAddress }>,
    scope: ServerAccountScope,
    address: TeamAddress,
): boolean {
    return snapshot.scope.serverId === scope.serverId
        && snapshot.scope.accountId === scope.accountId
        && snapshot.address.serverId === address.serverId
        && snapshot.address.teamId === address.teamId;
}

/**
 * Team projection subscriptions; catalog consumers select their exact admitted demands.
 *
 * A surface subscribes once and reads whichever rows it needs synchronously, so
 * a list of cards never becomes a list of subscriptions.
 */
export function subscribeTeamsSnapshots(listener: () => void, selection?: Readonly<{
    scope: ServerAccountScope | null | undefined;
    credentialCatalogs: readonly Readonly<{ address: TeamAddress; application?: ProviderBrokerApplicationBindingV1; executionMachineId?: string }>[];
}> | Readonly<{ scopes: readonly ServerAccountScope[]; slices: readonly TeamsSnapshotSlice[] }>): () => void {
    if (selection && 'slices' in selection) {
        const keys = new Set(selection.scopes.flatMap(scope => selection.slices.map(slice => sliceKey(scope, slice))));
        for (const key of keys) {
            const registered = sliceListeners.get(key) ?? new Set();
            registered.add(listener);
            sliceListeners.set(key, registered);
        }
        return () => {
            for (const key of keys) {
                const registered = sliceListeners.get(key);
                registered?.delete(listener);
                if (registered?.size === 0) sliceListeners.delete(key);
            }
        };
    }
    if (selection) {
        const { scope } = selection;
        return credentialCatalogs.subscribe(scope ? selection.credentialCatalogs.map(demand =>
            teamCredentialResourceCatalogKey(scope, demand.address, demand.application, demand.executionMachineId)) : [], listener);
    }
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getTeamsDirectorySnapshot(
    scope: ServerAccountScope | null | undefined,
    queryKey: string,
): TeamsDirectorySnapshot | null {
    if (!scope) return null;
    return directories.get(directoryKey(scope, queryKey)) ?? null;
}

const MEMBER_DIRECTORY_QUERY_KEYS = Object.freeze([
    teamDirectoryQueryKeyV1({ v: 1, scope: 'member', archived: 'active' }),
    teamDirectoryQueryKeyV1({ v: 1, scope: 'member', archived: 'archived' }),
]);

/**
 * One Team's row in this Account's own Teams directory (active, then archived): the projection the Teams rail draws.
 * A surface that opens before the Team itself is read (its header) shows what the rail already shows. A directory
 * the Home refused says nothing about its Teams.
 */
export function readTeamsDirectoryRow(scope: ServerAccountScope | null | undefined, teamId: string): TeamSummaryV1 | null {
    if (!scope) return null;
    for (const queryKey of MEMBER_DIRECTORY_QUERY_KEYS) {
        const snapshot = getTeamsDirectorySnapshot(scope, queryKey);
        if (!snapshot || isAuthoritativeScopedSnapshotRefusal(snapshot.error)) continue;
        const row = snapshot.data?.find(team => team.id === teamId);
        if (row) return row;
    }
    return null;
}

/** Read a retained setup offer's Team even after the step has been dismissed. */
export function readTeamSetupStepName(scope: ServerAccountScope, stepId: string): string | null {
    if (!stepId.startsWith('team:')) return null;
    for (const snapshot of directories.values()) {
        if (snapshot.scope.serverId !== scope.serverId || snapshot.scope.accountId !== scope.accountId) continue;
        if (isAuthoritativeScopedSnapshotRefusal(snapshot.error)) continue;
        const team = snapshot.data?.find(team => team.hasSetup === true && team.viewerJoinedAt != null
            && teamSetupStepId(scope, { serverId: scope.serverId, teamId: team.id }) === stepId);
        if (team) return team.name;
    }
    return null;
}

/** Directory presentation facts, including cursor/currentness changes, independent of observation time. */
export function getTeamsDirectorySnapshotsSelectionKey(
    scopes: readonly ServerAccountScope[],
    queryKeys: readonly string[],
): string {
    return JSON.stringify(scopes.flatMap(scope => queryKeys.map(queryKey => {
        const snapshot = getTeamsDirectorySnapshot(scope, queryKey);
        return [snapshotReferenceSelectionKey([snapshot?.data]), snapshot?.nextCursor ?? null,
            snapshot?.status ?? 'none', snapshot?.stale === true, snapshot?.reachability ?? 'unknown',
            snapshot?.error?.kind ?? null, snapshot?.error?.retryable ?? null, snapshot?.error?.code ?? null];
    })));
}

export function getTeamSnapshot(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
): TeamSnapshot | null {
    if (!scope || !address) return null;
    return teams.get(serverAccountScopedTeamKey(scope, address)) ?? null;
}

export function getTeamGroupsSnapshot(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    queryKey: string,
): TeamGroupsSnapshot | null {
    if (!scope || !address) return null;
    return groupLists.get(groupListKey(scope, address, queryKey)) ?? null;
}

export function getTeamMembersSnapshot(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    queryKey: string,
): TeamMembersSnapshot | null {
    if (!scope || !address) return null;
    return memberLists.get(teamMembersSnapshotKey(scope, address, queryKey)) ?? null;
}

export function getTeamSharedResourcesSummarySnapshot(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
): TeamSharedResourcesSummarySnapshot | null {
    if (!scope || !address) return null;
    const snapshot = sharedResourceSummaries.get(sharedResourceSummaryKey(scope, address));
    return snapshot?.lifetime.isCurrent() ? snapshot : null;
}

export function invalidateTeamSharedResourcesSummary(scope: ServerAccountScope, address: TeamAddress): void {
    const current = getTeamSharedResourcesSummarySnapshot(scope, address);
    if (!current || current.status === 'loading') return;
    sharedResourceSummaries.set(sharedResourceSummaryKey(scope, address), Object.freeze({ ...current, status: 'loading' }));
    notify([sliceKey(scope, 'sharedResources')]);
}

export function applyTeamSharedResourcesSummary(
    scope: ServerAccountScope,
    address: TeamAddress,
    data: readonly TeamSharedResourceSummaryRowV1[],
    lifetime: ServerAccountScopeLifetime,
    current = true,
): void {
    const previous = getTeamSharedResourcesSummarySnapshot(scope, address);
    sharedResourceSummaries.set(sharedResourceSummaryKey(scope, address), Object.freeze({
        scope,
        address,
        lifetime: readServerAccountScopeOwnerLifetime(lifetime),
        data: retainKeyedRows(previous?.data ?? null, data, teamSharedResourceSummaryRowKeyV1),
        status: current ? 'ready' : 'loading',
        error: null,
    }));
    notify([sliceKey(scope, 'sharedResources')]);
}

export function applyTeamSharedResourcesSummaryFailure(
    scope: ServerAccountScope,
    address: TeamAddress,
    error: HomeDomainFailure,
    lifetime: ServerAccountScopeLifetime,
): void {
    const previous = getTeamSharedResourcesSummarySnapshot(scope, address);
    const withdrawn = isAuthoritativeScopedSnapshotRefusalKind(error.kind);
    sharedResourceSummaries.set(sharedResourceSummaryKey(scope, address), Object.freeze({
        scope,
        address,
        lifetime: readServerAccountScopeOwnerLifetime(lifetime),
        data: withdrawn ? null : previous?.data ?? null,
        status: 'error',
        error,
    }));
    notify([sliceKey(scope, 'sharedResources')]);
}

export function beginTeamMembersLoad(scope: ServerAccountScope, address: TeamAddress, queryKey: string, continuation = false): void {
    const current = getTeamMembersSnapshot(scope, address, queryKey);
    memberLists.set(teamMembersSnapshotKey(scope, address, queryKey), Object.freeze({
        scope, address, queryKey, status: continuation ? 'loading_more' : 'loading',
        data: current?.data ?? null, nextCursor: current?.nextCursor ?? null,
        stale: current?.stale ?? false, error: null,
    }));
    notify([sliceKey(scope, 'members')]);
}

export function applyTeamMembersPage(params: Readonly<{
    scope: ServerAccountScope; address: TeamAddress; queryKey: string;
    items: readonly TeamMembershipV1[]; nextCursor: string | null; append?: boolean; current?: boolean;
}>): void {
    const previous = getTeamMembersSnapshot(params.scope, params.address, params.queryKey);
    const incoming = params.append ? [...(previous?.data ?? []), ...params.items] : params.items;
    memberLists.set(teamMembersSnapshotKey(params.scope, params.address, params.queryKey), Object.freeze({
        scope: params.scope, address: params.address, queryKey: params.queryKey, status: 'ready',
        data: retainKeyedRows(previous?.data ?? null, incoming, row => row.id), nextCursor: params.nextCursor,
        stale: params.current === false, error: null,
    }));
    notify([sliceKey(params.scope, 'members')]);
}

export function applyTeamMembersFailure(params: Readonly<{
    scope: ServerAccountScope; address: TeamAddress; queryKey: string; error: HomeDomainFailure;
}>): void {
    const previous = getTeamMembersSnapshot(params.scope, params.address, params.queryKey);
    const withdrawn = isAuthoritativeScopedSnapshotRefusalKind(params.error.kind);
    memberLists.set(teamMembersSnapshotKey(params.scope, params.address, params.queryKey), Object.freeze({
        scope: params.scope, address: params.address, queryKey: params.queryKey, status: 'error',
        data: withdrawn ? null : previous?.data ?? null,
        nextCursor: withdrawn || params.error.code === 'invalid_team_cursor' ? null : previous?.nextCursor ?? null,
        stale: !withdrawn && Boolean(previous?.data), error: params.error,
    }));
    notify([sliceKey(params.scope, 'members')]);
}

export function invalidateTeamMembersSnapshot(scope: ServerAccountScope, address: TeamAddress, queryKey: string): void {
    const current = getTeamMembersSnapshot(scope, address, queryKey);
    if (!current || current.stale) return;
    memberLists.set(teamMembersSnapshotKey(scope, address, queryKey), Object.freeze({ ...current, stale: true }));
    notify([sliceKey(scope, 'members')]);
}

/** Unlike label projections, a roster search has no reader after its last observer leaves. */
export function retireTeamMembersSnapshot(scope: ServerAccountScope, address: TeamAddress, queryKey: string): void {
    if (memberLists.delete(teamMembersSnapshotKey(scope, address, queryKey))) notify([sliceKey(scope, 'members')]);
}

export function getTeamGroupSnapshot(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    groupId: string,
): TeamGroupSnapshot | null {
    if (!scope || !address || groupId === '') return null;
    return groups.get(groupKey(scope, address, groupId)) ?? null;
}

export function getTeamCredentialResourcesSnapshot(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    queryKey = '',
): TeamCredentialResourcesSnapshot | null {
    if (!scope || !address) return null;
    return credentialLists.get(credentialListKey(scope, address, queryKey)) ?? null;
}

export function getTeamCredentialResourceCatalogSnapshot(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    application?: ProviderBrokerApplicationBindingV1,
    executionMachineId?: string,
): TeamCredentialResourceCatalogSnapshot | null {
    if (!scope || !address) return null;
    return credentialCatalogs.get(teamCredentialResourceCatalogKey(scope, address, application, executionMachineId)) ?? null;
}

/** Picker facts exclude observation time; data identities are reconciled on admission below. */
export function getTeamCredentialResourceCatalogsSelectionKey(
    scope: ServerAccountScope | null | undefined,
    demands: readonly Readonly<{ address: TeamAddress; application?: ProviderBrokerApplicationBindingV1; executionMachineId?: string }>[],
): string {
    return JSON.stringify(demands.map(({ address, application, executionMachineId }) => {
        const snapshot = getTeamCredentialResourceCatalogSnapshot(scope, address, application, executionMachineId);
        return [snapshotReferenceSelectionKey([snapshot?.data]), snapshot?.status ?? 'none',
            snapshot?.stale === true, snapshot?.selectionCurrent === true,
            snapshot?.error?.kind ?? null, snapshot?.error?.retryable ?? null, snapshot?.error?.code ?? null];
    }));
}

/** One identity shared by the retained snapshot and its in-flight loader. */
export function teamCredentialResourceCatalogKey(scope: ServerAccountScope, address: TeamAddress,
    application?: ProviderBrokerApplicationBindingV1, executionMachineId?: string): string {
    return JSON.stringify([serverAccountScopedTeamKey(scope, address), application ? [application.agentTargetKey,
        application.implementationIdentity.pluginId, application.implementationIdentity.localId,
        application.endpointTemplateId, application.protocol] : null, executionMachineId ?? null]);
}

/** Recipient-safe cached names for an exact Account; display reads confer no resource authority. */
export function readTeamCredentialResourceCatalogs(scope: ServerAccountScope): readonly TeamCredentialResourceCatalogEntryV1[] {
    return [...credentialCatalogs.values()].flatMap(snapshot => snapshot.scope.serverId === scope.serverId
        && snapshot.scope.accountId === scope.accountId ? snapshot.data ?? [] : []);
}

/**
 * An approval carries the Home-local resource ID without its Team address.
 * Only projected labels in this viewer's retained rows can name it.
 */
export function readTeamCredentialResourceApprovalProjection(
    scope: ServerAccountScope,
    resourceId: string,
): Pick<TeamCredentialResourceSummaryV1, 'teamId' | 'displayName'> | null {
    const exact = [...credentialResources.values()].find(snapshot => snapshot.resourceId === resourceId
        && credentialSnapshotMatches(snapshot, scope, snapshot.address));
    if (exact?.error && isAuthoritativeScopedSnapshotRefusal(exact.error)) return null;
    const list = [...credentialLists.values()].find(snapshot => credentialSnapshotMatches(snapshot, scope, snapshot.address)
        && snapshot.data?.some(resource => resource.id === resourceId));
    const address = exact?.address ?? list?.address;
    return (address ? readTeamCredentialResource(scope, address, resourceId) : null)
        ?? readTeamCredentialResourceCatalogs(scope).find(resource => resource.id === resourceId)
        ?? null;
}

export function getTeamCredentialResourceSnapshot(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    resourceId: string,
): TeamCredentialResourceSnapshot | null {
    if (!scope || !address || resourceId === '') return null;
    return credentialResources.get(credentialResourceKey(scope, address, resourceId)) ?? null;
}

/**
 * One resource by id from the projection the Team already loaded.
 *
 * Exact-resource observations take precedence. A presentation-ready row from
 * an already-loaded administration list remains a useful fallback while its
 * exact read is opening, without making the detail route own list pagination.
 */
export function readTeamCredentialResource(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    resourceId: string,
): TeamCredentialResourceSummaryV1 | null {
    if (!scope || !address || resourceId === '') return null;
    const exact = getTeamCredentialResourceSnapshot(scope, address, resourceId)?.data ?? null;
    if (exact) return exact;
    // A row opened from a search/filter result remains the same Home-authorized
    // administration row. Search identity scopes retained sequences, not the
    // resource itself, so detail may read it from any exact-scope sequence.
    let selected: Readonly<{ row: TeamCredentialResourceSummaryV1; observedAt: number }> | null = null;
    for (const snapshot of credentialLists.values()) {
        if (!credentialSnapshotMatches(snapshot, scope, address)) continue;
        const resource = snapshot.data?.find((row) => row.id === resourceId);
        if (!resource) continue;
        const observedAt = snapshot.lastObservedAt ?? -1;
        if (selected === null || observedAt >= selected.observedAt) {
            selected = { row: resource, observedAt };
        }
    }
    return selected?.row ?? null;
}

export function beginTeamCredentialResourceLoad(
    scope: ServerAccountScope,
    address: TeamAddress,
    resourceId: string,
): void {
    const current = getTeamCredentialResourceSnapshot(scope, address, resourceId);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === null) return;
    credentialResources.set(credentialResourceKey(scope, address, resourceId), Object.freeze({
        scope,
        address,
        resourceId,
        status,
        data: current?.data ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify([sliceKey(scope, 'credentialResources')]);
}

export function applyTeamCredentialResource(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    resource: TeamCredentialResourceSummaryV1;
    observedAt: number;
    current?: boolean;
}>): void {
    const current = getTeamCredentialResourceSnapshot(params.scope, params.address, params.resource.id);
    const data = current?.data && areProjectionsEquivalent(current.data, params.resource)
        ? current.data
        : params.resource;
    credentialResources.set(credentialResourceKey(params.scope, params.address, params.resource.id), Object.freeze({
        scope: params.scope,
        address: params.address,
        resourceId: params.resource.id,
        status: 'ready',
        data,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
    notify([sliceKey(params.scope, 'credentialResources')]);
}

export function applyTeamCredentialResourceFailure(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    resourceId: string;
    error: ScopedSnapshotError;
}>): void {
    const current = getTeamCredentialResourceSnapshot(params.scope, params.address, params.resourceId);
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    credentialResources.set(credentialResourceKey(params.scope, params.address, params.resourceId), Object.freeze({
        scope: params.scope,
        address: params.address,
        resourceId: params.resourceId,
        status: 'error',
        data: withdrawn ? null : current?.data ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    }));
    notify([sliceKey(params.scope, 'credentialResources')]);
}

/**
 * The synchronous Group readers for surfaces that need a Group's name or its
 * Team-qualified identity while rendering a row.
 *
 * Session rows, Activity, Inbox and notification context all need a label for a
 * Group they did not open, and there may be many of them on one screen. They
 * subscribe once through `subscribeTeamsSnapshots` and call these; there is no
 * per-card subscription and no separate label cache, because the projection
 * these read is the same one the Groups surface already loads.
 *
 * Rows that a later refresh marked stale are still returned: a stale Group name
 * is the last thing the Home actually said, and blanking a label while a refresh
 * runs would be less truthful than showing it.
 */
export function readTeamGroups(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    archived: 'active' | 'archived',
): readonly TeamGroupV1[] | null {
    if (!scope || !address) return null;
    const queryKey = teamGroupsQueryKeyV1({ v: 1, teamId: address.teamId, archived });
    return getTeamGroupsSnapshot(scope, address, queryKey)?.data ?? null;
}

/**
 * One Group by id, from whichever projection already holds it: its own detail
 * read, or the Groups sequence a surface loaded. A caller that only needs a
 * label therefore does not force a detail read it would otherwise not perform.
 */
export function readTeamGroup(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    groupId: string,
): TeamGroupV1 | null {
    if (!scope || !address || groupId === '') return null;
    const detail = getTeamGroupSnapshot(scope, address, groupId)?.data ?? null;
    if (detail) return detail;
    for (const archived of ['active', 'archived'] as const) {
        const found = readTeamGroups(scope, address, archived)?.find((row) => row.id === groupId);
        if (found) return found;
    }
    return null;
}

function areTeamSummariesEquivalent(a: TeamSummaryV1, b: TeamSummaryV1): boolean {
    return areProjectionsEquivalent(a, b);
}

export function beginTeamsDirectoryLoad(scope: ServerAccountScope, queryKey: string): void {
    const current = getTeamsDirectorySnapshot(scope, queryKey);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === null) return;
    directories.set(directoryKey(scope, queryKey), Object.freeze({
        scope,
        queryKey,
        status,
        data: current?.data ?? null,
        nextCursor: current?.nextCursor ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify([sliceKey(scope, 'directory')]);
}

/**
 * Publishes one page. `append` continues an existing sequence; otherwise the
 * page replaces the directory, still reusing unchanged Team objects.
 */
export function applyTeamsDirectoryPage(params: Readonly<{
    scope: ServerAccountScope;
    queryKey: string;
    items: readonly TeamSummaryV1[];
    nextCursor?: string | null;
    observedAt: number;
    append?: boolean;
    current?: boolean;
}>): void {
    const current = getTeamsDirectorySnapshot(params.scope, params.queryKey);
    const incoming = params.append === true
        ? [...(current?.data ?? []), ...params.items]
        : params.items;
    const data = retainKeyedRows(current?.data ?? null, incoming, row => row.id);
    directories.set(directoryKey(params.scope, params.queryKey), Object.freeze({
        scope: params.scope,
        queryKey: params.queryKey,
        status: 'ready',
        data,
        nextCursor: params.nextCursor ?? null,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
    let seededTeamDetail = false;
    if (params.current !== false) {
        for (const row of params.items) {
            if (row.authenticationQualification?.ok !== true || !row.capabilities.viewTeam) continue;
            const address = { serverId: params.scope.serverId, teamId: row.id };
            const key = serverAccountScopedTeamKey(params.scope, address);
            if (teams.has(key)) continue;
            seededTeamDetail = true;
            teams.set(key, Object.freeze({
                scope: params.scope,
                address,
                status: 'ready',
                data: row,
                lastObservedAt: params.observedAt,
                // Render immediately while the exact detail read revalidates the projection.
                stale: true,
                reachability: 'reachable',
                error: null,
            }));
        }
    }
    const keys = [sliceKey(params.scope, 'directory')];
    if (seededTeamDetail) keys.push(sliceKey(params.scope, 'team'));
    notify(keys);
}

export function applyTeamsDirectoryFailure(params: Readonly<{
    scope: ServerAccountScope;
    queryKey: string;
    error: ScopedSnapshotError;
}>): void {
    const current = getTeamsDirectorySnapshot(params.scope, params.queryKey);
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    directories.set(directoryKey(params.scope, params.queryKey), Object.freeze({
        scope: params.scope,
        queryKey: params.queryKey,
        status: 'error',
        // The last known directory stays visible and is marked stale rather than
        // flashing an empty Teams list.
        data: withdrawn ? null : current?.data ?? null,
        nextCursor: withdrawn || params.error.code === 'invalid_team_cursor' ? null : current?.nextCursor ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    }));
    notify([sliceKey(params.scope, 'directory')]);
}

export function beginTeamGroupsLoad(
    scope: ServerAccountScope,
    address: TeamAddress,
    queryKey: string,
): void {
    const current = getTeamGroupsSnapshot(scope, address, queryKey);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === null) return;
    groupLists.set(groupListKey(scope, address, queryKey), Object.freeze({
        scope,
        address,
        queryKey,
        status,
        data: current?.data ?? null,
        nextCursor: current?.nextCursor ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify([sliceKey(scope, 'groups')]);
}

export function applyTeamGroupsPage(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    queryKey: string;
    items: readonly TeamGroupV1[];
    nextCursor: string | null;
    observedAt: number;
    append?: boolean;
    current?: boolean;
}>): void {
    const current = getTeamGroupsSnapshot(params.scope, params.address, params.queryKey);
    const incoming = params.append === true
        ? [...(current?.data ?? []), ...params.items]
        : params.items;
    groupLists.set(groupListKey(params.scope, params.address, params.queryKey), Object.freeze({
        scope: params.scope,
        address: params.address,
        queryKey: params.queryKey,
        status: 'ready',
        data: retainKeyedRows(current?.data ?? null, incoming, row => row.id),
        nextCursor: params.nextCursor ?? null,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
    notify([sliceKey(params.scope, 'groups')]);
}

export function applyTeamGroupsFailure(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    queryKey: string;
    error: ScopedSnapshotError;
}>): void {
    const current = getTeamGroupsSnapshot(params.scope, params.address, params.queryKey);
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    groupLists.set(groupListKey(params.scope, params.address, params.queryKey), Object.freeze({
        scope: params.scope,
        address: params.address,
        queryKey: params.queryKey,
        status: 'error',
        // The pages already read stay visible and are marked stale rather than
        // blanking a Groups list because a later read failed.
        data: withdrawn ? null : current?.data ?? null,
        nextCursor: withdrawn || params.error.code === 'invalid_team_cursor' ? null : current?.nextCursor ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    }));
    notify([sliceKey(params.scope, 'groups')]);
}

export function beginTeamCredentialResourcesLoad(
    scope: ServerAccountScope,
    address: TeamAddress,
    queryKey = '',
): void {
    const current = getTeamCredentialResourcesSnapshot(scope, address, queryKey);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === null) return;
    credentialLists.set(credentialListKey(scope, address, queryKey), Object.freeze({
        scope,
        address,
        queryKey,
        status,
        data: current?.data ?? null,
        nextCursor: current?.nextCursor ?? null,
        viewer: current?.viewer ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify([sliceKey(scope, 'credentialResources')]);
}

export function applyTeamCredentialResourcesPage(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    queryKey?: string;
    resources: readonly TeamCredentialResourceSummaryV1[];
    nextCursor?: string | null;
    viewer: TeamCredentialViewerCapabilitiesV1;
    observedAt: number;
    current?: boolean;
    append?: boolean;
}>): void {
    const queryKey = params.queryKey ?? '';
    const current = getTeamCredentialResourcesSnapshot(params.scope, params.address, queryKey);
    let resources = params.resources;
    if (params.append && current?.data) {
        const existingIds = new Set(current.data.map((resource) => resource.id));
        resources = [...current.data, ...params.resources.filter((incoming) => !existingIds.has(incoming.id))];
    }
    credentialLists.set(credentialListKey(params.scope, params.address, queryKey), Object.freeze({
        scope: params.scope,
        address: params.address,
        queryKey,
        status: 'ready',
        data: retainKeyedRows(current?.data ?? null, resources, row => row.id),
        nextCursor: params.nextCursor ?? null,
        viewer: current?.viewer && areProjectionsEquivalent(current.viewer, params.viewer)
            ? current.viewer
            : params.viewer,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
    notify([sliceKey(params.scope, 'credentialResources')]);
}

export function applyTeamCredentialResourcesFailure(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    queryKey?: string;
    error: ScopedSnapshotError;
}>): void {
    const queryKey = params.queryKey ?? '';
    const current = getTeamCredentialResourcesSnapshot(params.scope, params.address, queryKey);
    // An authoritative refusal withdraws the viewer decision as well as the
    // rows: continuing to offer management the Home has just denied would be
    // the one failure this projection exists to prevent.
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    const failed: TeamCredentialResourcesSnapshot = Object.freeze({
        scope: params.scope,
        address: params.address,
        queryKey,
        status: 'error',
        data: withdrawn ? null : current?.data ?? null,
        nextCursor: withdrawn ? null : current?.nextCursor ?? null,
        viewer: withdrawn ? null : current?.viewer ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    });
    credentialLists.set(credentialListKey(params.scope, params.address, queryKey), failed);
    if (withdrawn) {
        // Authorization is Team-resource authority, not query authority. A
        // refusal on one filter therefore withdraws every retained variant.
        for (const [key, snapshot] of credentialLists) {
            if (key === credentialListKey(params.scope, params.address, queryKey)
                || !credentialSnapshotMatches(snapshot, params.scope, params.address)) continue;
            credentialLists.set(key, Object.freeze({
                ...snapshot,
                status: 'error',
                data: null,
                nextCursor: null,
                viewer: null,
                lastObservedAt: null,
                stale: false,
                reachability: reachabilityForScopedSnapshotError(params.error),
                error: params.error,
            }));
        }
    }
    notify([sliceKey(params.scope, 'credentialResources')]);
}

export function beginTeamCredentialResourceCatalogLoad(
    scope: ServerAccountScope,
    address: TeamAddress,
    application?: ProviderBrokerApplicationBindingV1,
    executionMachineId?: string,
): void {
    const current = getTeamCredentialResourceCatalogSnapshot(scope, address, application, executionMachineId);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === null) return;
    credentialCatalogs.set(teamCredentialResourceCatalogKey(scope, address, application, executionMachineId), Object.freeze({
        scope,
        address,
        ...(application ? { application } : {}),
        ...(executionMachineId ? { executionMachineId } : {}),
        status,
        data: current?.data ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        selectionCurrent: current?.selectionCurrent ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify([sliceKey(scope, 'credentialCatalog')]);
}

export function applyTeamCredentialResourceCatalog(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    application?: ProviderBrokerApplicationBindingV1;
    executionMachineId?: string;
    resources: readonly TeamCredentialResourceCatalogEntryV1[];
    observedAt: number;
    current?: boolean;
}>): void {
    const changed = credentialCatalogs.set(teamCredentialResourceCatalogKey(params.scope, params.address, params.application, params.executionMachineId), Object.freeze({
        scope: params.scope,
        address: params.address,
        ...(params.application ? { application: params.application } : {}),
        ...(params.executionMachineId ? { executionMachineId: params.executionMachineId } : {}),
        status: 'ready',
        data: params.resources,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        selectionCurrent: params.current !== false,
        reachability: 'reachable',
        error: null,
    }));
    if (changed) notify([sliceKey(params.scope, 'credentialCatalog')]);
}

export function applyTeamCredentialResourceCatalogFailure(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    application?: ProviderBrokerApplicationBindingV1;
    executionMachineId?: string;
    error: ScopedSnapshotError;
}>): void {
    const current = getTeamCredentialResourceCatalogSnapshot(params.scope, params.address, params.application, params.executionMachineId);
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    const changed = credentialCatalogs.set(teamCredentialResourceCatalogKey(params.scope, params.address, params.application, params.executionMachineId), Object.freeze({
        scope: params.scope,
        address: params.address,
        ...(params.application ? { application: params.application } : {}),
        ...(params.executionMachineId ? { executionMachineId: params.executionMachineId } : {}),
        status: 'error',
        data: withdrawn ? null : current?.data ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        // A transient read failure does not retract the last admitted picker choice.
        // Preserve withdrawal from a real Home loss, refusal, mutation or observer gap.
        selectionCurrent: params.error.kind === 'unknown' && params.error.retryable
            && current?.selectionCurrent === true,
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    }));
    if (changed) notify([sliceKey(params.scope, 'credentialCatalog')]);
}

export function invalidateTeamCredentialResourceCatalog(
    scope: ServerAccountScope,
    address: TeamAddress,
    application?: ProviderBrokerApplicationBindingV1,
    options?: Readonly<{ retainSelection: boolean }>,
    executionMachineId?: string,
): boolean {
    const changed = markTeamCredentialResourceCatalogStale(scope, address, application, options?.retainSelection === true, executionMachineId);
    if (!changed) return false;
    notify([sliceKey(scope, 'credentialCatalog')]);
    return true;
}

function markTeamCredentialResourceCatalogStale(
    scope: ServerAccountScope,
    address: TeamAddress,
    application?: ProviderBrokerApplicationBindingV1,
    retainSelection = false,
    executionMachineId?: string,
): boolean {
    const key = teamCredentialResourceCatalogKey(scope, address, application, executionMachineId);
    const current = credentialCatalogs.get(key);
    if (!current || (current.stale && (retainSelection || !current.selectionCurrent))) return false;
    credentialCatalogs.set(key, Object.freeze({ ...current, stale: true,
        selectionCurrent: retainSelection && current.selectionCurrent }));
    return true;
}

export function invalidateTeamCredentialResourcesSnapshot(
    scope: ServerAccountScope,
    address: TeamAddress,
    queryKey = '',
): boolean {
    const key = credentialListKey(scope, address, queryKey);
    const current = credentialLists.get(key);
    if (!current || current.stale) return false;
    credentialLists.set(key, Object.freeze({ ...current, stale: true }));
    notify([sliceKey(scope, 'credentialResources')]);
    return true;
}

export function invalidateTeamCredentialResourceSnapshot(
    scope: ServerAccountScope,
    address: TeamAddress,
    resourceId: string,
): boolean {
    const key = credentialResourceKey(scope, address, resourceId);
    const current = credentialResources.get(key);
    if (!current || current.stale) return false;
    credentialResources.set(key, Object.freeze({ ...current, stale: true }));
    notify([sliceKey(scope, 'credentialResources')]);
    return true;
}

/**
 * Marks the Team's resource projection stale after a mutation answered.
 *
 * A create, update, audience change or delete changes rows this answer does not
 * describe — an audience change alters no field of the summary the caller holds
 * — so the one projection re-reads rather than each surface predicting a row.
 */
export function invalidateTeamCredentialResources(
    scope: ServerAccountScope,
    address: TeamAddress,
    resourceId?: string,
): boolean {
    const changedKeys = new Set<string>();
    for (const [key, current] of credentialLists) {
        if (current.stale || !credentialSnapshotMatches(current, scope, address)) continue;
        credentialLists.set(key, Object.freeze({ ...current, stale: true }));
        changedKeys.add(sliceKey(current.scope, 'credentialResources'));
    }
    for (const [key, current] of credentialResources) {
        if (current.stale || !credentialSnapshotMatches(current, scope, address)) continue;
        if (resourceId !== undefined && current.resourceId !== resourceId) continue;
        credentialResources.set(key, Object.freeze({ ...current, stale: true }));
        changedKeys.add(sliceKey(current.scope, 'credentialResources'));
    }
    for (const [key, current] of credentialCatalogs) {
        if ((current.stale && !current.selectionCurrent) || !credentialSnapshotMatches(current, scope, address)) continue;
        credentialCatalogs.set(key, Object.freeze({ ...current, stale: true, selectionCurrent: false }));
        changedKeys.add(sliceKey(current.scope, 'credentialCatalog'));
    }
    if (changedKeys.size) notify([...changedKeys]);
    return changedKeys.size > 0;
}

export function beginTeamGroupLoad(
    scope: ServerAccountScope,
    address: TeamAddress,
    groupId: string,
): void {
    const current = getTeamGroupSnapshot(scope, address, groupId);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === null) return;
    groups.set(groupKey(scope, address, groupId), Object.freeze({
        scope,
        address,
        groupId,
        status,
        data: current?.data ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify([sliceKey(scope, 'groups')]);
}

/**
 * Publishes one Group. Mutations answer with the row the viewer now sees, so a
 * successful edit, archive or restore publishes here and every surface holding
 * that Group observes the Home's own truth without a second read.
 */
export function applyTeamGroupProjection(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    group: TeamGroupV1;
    observedAt: number;
    current?: boolean;
}>): void {
    const current = getTeamGroupSnapshot(params.scope, params.address, params.group.id);
    const data = current?.data && areProjectionsEquivalent(current.data, params.group)
        ? current.data
        : params.group;
    groups.set(groupKey(params.scope, params.address, params.group.id), Object.freeze({
        scope: params.scope,
        address: params.address,
        groupId: params.group.id,
        status: 'ready',
        data,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
    notify([sliceKey(params.scope, 'groups')]);
}

export function applyTeamGroupFailure(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    groupId: string;
    error: ScopedSnapshotError;
}>): void {
    const current = getTeamGroupSnapshot(params.scope, params.address, params.groupId);
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    groups.set(groupKey(params.scope, params.address, params.groupId), Object.freeze({
        scope: params.scope,
        address: params.address,
        groupId: params.groupId,
        status: 'error',
        data: withdrawn ? null : current?.data ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    }));
    notify([sliceKey(params.scope, 'groups')]);
}

/**
 * Marks every Group projection for one Team stale after a Group mutation, so a
 * create or a membership change re-reads the one sequence instead of leaving a
 * list that no longer matches the Home.
 */
export function invalidateTeamGroupsForTeam(scope: ServerAccountScope, address: TeamAddress): boolean {
    const prefix = serverAccountScopedTeamKey(scope, address);
    let changed = false;
    for (const [key, snapshot] of groupLists) {
        if (!key.startsWith(prefix) || snapshot.stale) continue;
        groupLists.set(key, Object.freeze({ ...snapshot, stale: true }));
        changed = true;
    }
    for (const [key, snapshot] of groups) {
        if (!key.startsWith(prefix) || snapshot.stale) continue;
        groups.set(key, Object.freeze({ ...snapshot, stale: true }));
        changed = true;
    }
    if (changed) notify([sliceKey(scope, 'groups')]);
    return changed;
}

export function beginTeamLoad(scope: ServerAccountScope, address: TeamAddress): void {
    const current = getTeamSnapshot(scope, address);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === null) return;
    teams.set(serverAccountScopedTeamKey(scope, address), Object.freeze({
        scope: current?.scope ?? scope,
        address: current?.address ?? address,
        status,
        data: current?.data ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify([sliceKey(scope, 'team')]);
}

export function applyTeamProjection(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    team: TeamSummaryV1;
    observedAt: number;
    current?: boolean;
}>): void {
    const current = getTeamSnapshot(params.scope, params.address);
    const data = current?.data && areTeamSummariesEquivalent(current.data, params.team)
        ? current.data
        : params.team;
    teams.set(serverAccountScopedTeamKey(params.scope, params.address), Object.freeze({
        scope: current?.scope ?? params.scope,
        address: current?.address ?? params.address,
        status: 'ready',
        data,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
    notify([sliceKey(params.scope, 'team')]);
}

export function applyTeamFailure(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    error: ScopedSnapshotError;
}>): void {
    const current = getTeamSnapshot(params.scope, params.address);
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    teams.set(serverAccountScopedTeamKey(params.scope, params.address), Object.freeze({
        scope: current?.scope ?? params.scope,
        address: current?.address ?? params.address,
        status: 'error',
        data: withdrawn ? null : current?.data ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    }));
    notify([sliceKey(params.scope, 'team')]);
}

/** Marks one exact directory query stale without touching sibling queries. */
export function invalidateTeamsDirectorySnapshot(
    scope: ServerAccountScope,
    queryKey: string,
): boolean {
    const key = directoryKey(scope, queryKey);
    const current = directories.get(key);
    if (!current || current.stale) return false;
    directories.set(key, Object.freeze({ ...current, stale: true }));
    notify([sliceKey(scope, 'directory')]);
    return true;
}

/** Marks one exact Team projection stale without touching the rest of its Home. */
export function invalidateTeamSnapshot(scope: ServerAccountScope, address: TeamAddress): boolean {
    const key = serverAccountScopedTeamKey(scope, address);
    const current = teams.get(key);
    if (!current || current.stale) return false;
    teams.set(key, Object.freeze({ ...current, stale: true }));
    notify([sliceKey(scope, 'team')]);
    return true;
}

export function invalidateTeamGroupsSnapshot(
    scope: ServerAccountScope,
    address: TeamAddress,
    queryKey: string,
): boolean {
    const key = groupListKey(scope, address, queryKey);
    const current = groupLists.get(key);
    if (!current || current.stale) return false;
    groupLists.set(key, Object.freeze({ ...current, stale: true }));
    notify([sliceKey(scope, 'groups')]);
    return true;
}

export function invalidateTeamGroupSnapshot(
    scope: ServerAccountScope,
    address: TeamAddress,
    groupId: string,
): boolean {
    const key = groupKey(scope, address, groupId);
    const current = groups.get(key);
    if (!current || current.stale) return false;
    groups.set(key, Object.freeze({ ...current, stale: true }));
    notify([sliceKey(scope, 'groups')]);
    return true;
}

/**
 * The Account-change wake seam for one exact Home. It only marks rows stale, so
 * a coalesced or missed wake is harmless and no Team is refetched per ID.
 */
export function invalidateTeamsSnapshotsForServer(serverIdRaw: string): boolean {
    const serverId = serverIdRaw.trim();
    if (!serverId) return false;
    const changedKeys = new Set<string>();
    for (const [key, snapshot] of directories) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        directories.set(key, Object.freeze({ ...snapshot, stale: true }));
        changedKeys.add(sliceKey(snapshot.scope, 'directory'));
    }
    for (const [key, snapshot] of teams) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        teams.set(key, Object.freeze({ ...snapshot, stale: true }));
        changedKeys.add(sliceKey(snapshot.scope, 'team'));
    }
    for (const [key, snapshot] of groupLists) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        groupLists.set(key, Object.freeze({ ...snapshot, stale: true }));
        changedKeys.add(sliceKey(snapshot.scope, 'groups'));
    }
    for (const [key, snapshot] of memberLists) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        memberLists.set(key, Object.freeze({ ...snapshot, stale: true }));
        changedKeys.add(sliceKey(snapshot.scope, 'members'));
    }
    for (const [key, snapshot] of groups) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        groups.set(key, Object.freeze({ ...snapshot, stale: true }));
        changedKeys.add(sliceKey(snapshot.scope, 'groups'));
    }
    for (const [key, snapshot] of credentialLists) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        credentialLists.set(key, Object.freeze({ ...snapshot, stale: true }));
        changedKeys.add(sliceKey(snapshot.scope, 'credentialResources'));
    }
    for (const [key, snapshot] of credentialCatalogs) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        // A wake requests a reread, not a refusal. Keep the last admitted
        // picker choices while authority freshness is withdrawn; actual
        // mutation, observer-gap and unavailable/refused reads withdraw selection too.
        credentialCatalogs.set(key, Object.freeze({ ...snapshot, stale: true }));
        changedKeys.add(sliceKey(snapshot.scope, 'credentialCatalog'));
    }
    for (const [key, snapshot] of credentialResources) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        credentialResources.set(key, Object.freeze({ ...snapshot, stale: true }));
        changedKeys.add(sliceKey(snapshot.scope, 'credentialResources'));
    }
    for (const [key, snapshot] of sharedResourceSummaries) {
        if (snapshot.scope.serverId !== serverId || snapshot.status !== 'ready') continue;
        sharedResourceSummaries.set(key, Object.freeze({ ...snapshot, status: 'loading', error: null }));
        changedKeys.add(sliceKey(snapshot.scope, 'sharedResources'));
    }
    if (changedKeys.size) notify([...changedKeys]);
    return changedKeys.size > 0;
}

/** Drops every Account's rows for one Home, for sign-out or credential change. */
export function clearTeamsSnapshotsForServer(serverIdRaw: string): void {
    const serverId = serverIdRaw.trim();
    if (!serverId) return;
    const changedKeys = new Set<string>();
    for (const [key, snapshot] of directories) {
        if (snapshot.scope.serverId !== serverId) continue;
        directories.delete(key);
        changedKeys.add(sliceKey(snapshot.scope, 'directory'));
    }
    for (const [key, snapshot] of teams) {
        if (snapshot.scope.serverId !== serverId) continue;
        teams.delete(key);
        changedKeys.add(sliceKey(snapshot.scope, 'team'));
    }
    // Group rows are retired with the same credential-scope lifecycle as the
    // Teams that own them; leaving them behind would outlive their credential.
    for (const [key, snapshot] of groupLists) {
        if (snapshot.scope.serverId !== serverId) continue;
        groupLists.delete(key);
        changedKeys.add(sliceKey(snapshot.scope, 'groups'));
    }
    for (const [key, snapshot] of memberLists) {
        if (snapshot.scope.serverId !== serverId) continue;
        memberLists.delete(key);
        changedKeys.add(sliceKey(snapshot.scope, 'members'));
    }
    for (const [key, snapshot] of groups) {
        if (snapshot.scope.serverId !== serverId) continue;
        groups.delete(key);
        changedKeys.add(sliceKey(snapshot.scope, 'groups'));
    }
    // A resource projection carries an audience and a viewer decision made for
    // one credential; it must not outlive that credential either.
    for (const [key, snapshot] of credentialLists) {
        if (snapshot.scope.serverId !== serverId) continue;
        credentialLists.delete(key);
        changedKeys.add(sliceKey(snapshot.scope, 'credentialResources'));
    }
    for (const [key, snapshot] of credentialCatalogs) {
        if (snapshot.scope.serverId !== serverId) continue;
        credentialCatalogs.delete(key);
        changedKeys.add(sliceKey(snapshot.scope, 'credentialCatalog'));
    }
    for (const [key, snapshot] of credentialResources) {
        if (snapshot.scope.serverId !== serverId) continue;
        credentialResources.delete(key);
        changedKeys.add(sliceKey(snapshot.scope, 'credentialResources'));
    }
    for (const [key, snapshot] of sharedResourceSummaries) {
        if (snapshot.scope.serverId !== serverId) continue;
        sharedResourceSummaries.delete(key);
        changedKeys.add(sliceKey(snapshot.scope, 'sharedResources'));
    }
    for (const observations of retainedTeamObservations) observations.clearForServer(serverId);
    if (changedKeys.size) notify([...changedKeys]);
}

/** Test-only reset of the module-owned snapshot caches. */
export function resetTeamsSnapshotsForTests(): void {
    directories.clear();
    teams.clear();
    groupLists.clear();
    memberLists.clear();
    groups.clear();
    credentialLists.clear();
    credentialCatalogs.clear();
    credentialResources.clear();
    sharedResourceSummaries.clear();
    for (const observations of retainedTeamObservations) observations.clear();
    listeners.clear();
    sliceListeners.clear();
}
