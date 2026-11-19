import type { HomeAdministrationEventV1, HomeGovernanceProjectionV1 } from '@happier-dev/protocol/home/governance';
import type { HomeIdentityConnectionV1 } from '@happier-dev/protocol/home';
import type { ManagedGitHubAppsListOutputV1 } from '@happier-dev/protocol/identity/githubApps';
import type { ManagedIdentityProviderV1 } from '@happier-dev/protocol/identity/providers';
import type { IdentityConnectionV1, TeamAdmissionModeApplicabilityV1, TeamIdentityEligibleProviderV1 } from '@happier-dev/protocol/teams';
import { snapshotReferenceSelectionKey } from '@/sync/domains/scope/snapshotReferenceSelectionKey';
import { retainDeep } from '@/sync/domains/state/structuralSharing';

import {
    readServerAccountScopeOwnerLifetime,
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
    type ServerAccountScopeLifetime,
} from '@/sync/domains/scope/serverAccountScope';

import {
    isAuthoritativeScopedSnapshotRefusal,
    reachabilityForScopedSnapshotError,
    type ScopedSnapshotError,
    type ScopedSnapshotReachability,
    type ScopedSnapshotStatus,
} from '@/sync/domains/scope/scopedSnapshotFacts';

/**
 * Home governance uses the shared scoped-snapshot vocabulary so its staleness
 * and reachability meanings cannot drift from the Teams snapshots woken by the
 * same Account-change signal.
 */
export type HomeGovernanceSnapshotStatus = ScopedSnapshotStatus;

export type HomeGovernanceReachability = ScopedSnapshotReachability;

export type HomeGovernanceSnapshotError = ScopedSnapshotError & Readonly<{
    /** The Home's typed governance code when it supplied one. */
    code?: string | null;
}>;

/**
 * One Home's governance projection for one exact Account.
 *
 * Keyed by `ServerAccountScope` rather than by bare server id: two Accounts on
 * one Home have different roles, capabilities and setup views and must never
 * read each other's rows.
 */
export type HomeGovernanceSnapshot = Readonly<{
    scope: ServerAccountScope;
    status: HomeGovernanceSnapshotStatus;
    /** The last successful observation. Retained across refresh and failure. */
    data: HomeGovernanceProjectionV1 | null;
    /** When `data` was observed, so a surface can explain how old it is. */
    lastObservedAt: number | null;
    /** True when `data` is known to be behind the Home. Never blanks `data`. */
    stale: boolean;
    reachability: HomeGovernanceReachability;
    error: HomeGovernanceSnapshotError | null;
}>;

const snapshots = new Map<string, HomeGovernanceSnapshot>();
const listeners = new Set<() => void>();

const activityObservations = new Map<string, Readonly<{
    lifetime: ServerAccountScopeLifetime;
    rows: readonly HomeAdministrationEventV1[];
}>>();

export function homeActivityQueryKey(scope: ServerAccountScope, targetId?: string): string {
    return JSON.stringify([scope.serverId, scope.accountId, targetId ?? null]);
}

export function getHomeActivityObservation(key: string): readonly HomeAdministrationEventV1[] | undefined {
    const observation = activityObservations.get(key);
    return observation?.lifetime.isCurrent() ? observation.rows : undefined;
}

export function applyHomeActivityObservation(
    key: string, lifetime: ServerAccountScopeLifetime, rows: readonly HomeAdministrationEventV1[] | null,
): void {
    if (!lifetime.isCurrent()) return;
    if (rows === null) activityObservations.delete(key);
    else activityObservations.set(key, { lifetime: readServerAccountScopeOwnerLifetime(lifetime), rows });
}

type ManagedIdentityProviderObservation = Readonly<{
    items: readonly ManagedIdentityProviderV1[];
    unreadableCount: number;
}>;

type IdentityConnectionObservation = Readonly<{
    items: readonly (IdentityConnectionV1 & Partial<Pick<HomeIdentityConnectionV1, 'teamsUsingIt'>>)[];
    eligibleProviders: readonly TeamIdentityEligibleProviderV1[];
    admissionModeApplicability?: TeamAdmissionModeApplicabilityV1;
    memberSignInUrl?: string | null;
}>;

export function managedIdentityQueryKey(scope: ServerAccountScope, teamId: string | null): string {
    return JSON.stringify([scope.serverId, scope.accountId, teamId]);
}

function createManagedIdentityObservations<Data>() {
    const observations = new Map<string, Readonly<{ lifetime: ServerAccountScopeLifetime; data: Data }>>();
    return {
        get(key: string): Data | undefined {
            const observation = observations.get(key);
            return observation?.lifetime.isCurrent() ? observation.data : undefined;
        },
        apply(key: string, lifetime: ServerAccountScopeLifetime, data: Data | null): void {
            if (!lifetime.isCurrent()) return;
            if (data === null) observations.delete(key);
            else observations.set(key, { lifetime: readServerAccountScopeOwnerLifetime(lifetime), data });
        },
        clearForServer(serverId: string): void {
            for (const [key, observation] of observations) {
                if (observation.lifetime.scope.serverId === serverId) observations.delete(key);
            }
        },
        clear(): void {
            observations.clear();
        },
    };
}

export const managedIdentityProviderObservations = createManagedIdentityObservations<ManagedIdentityProviderObservation>();
export const managedGitHubAppsObservations = createManagedIdentityObservations<ManagedGitHubAppsListOutputV1>();
export const identityConnectionObservations = createManagedIdentityObservations<IdentityConnectionObservation>();

function notify(): void {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            // One subscriber cannot prevent its siblings from observing.
        }
    }
}

/**
 * A selection token over the authority facts only: the projection (identity retained while equal), its error and
 * staleness. Load progress (`refreshing`) and the observation time change it not, so an equal revalidation reaches no
 * reader that decides admission or navigation from the projection.
 */
export function getHomeGovernanceAuthoritySelectionKey(scopes: readonly ServerAccountScope[]): string {
    return scopes.map(scope => {
        const snapshot = getHomeGovernanceSnapshot(scope);
        if (!snapshot) return '-';
        const error = snapshot.error ? `${snapshot.error.kind}:${snapshot.error.code ?? ''}:${snapshot.error.retryable}` : '';
        return `${snapshotReferenceSelectionKey([snapshot.data])}|${snapshot.stale ? 1 : 0}|${error}`;
    }).join(',');
}

function keyOf(scope: ServerAccountScope): string {
    return serverAccountScopeKeySuffix(scope);
}

function write(scope: ServerAccountScope, next: HomeGovernanceSnapshot): void {
    snapshots.set(keyOf(scope), next);
    notify();
}

export function getHomeGovernanceSnapshot(
    scope: ServerAccountScope | null | undefined,
): HomeGovernanceSnapshot | null {
    if (!scope) return null;
    return snapshots.get(keyOf(scope)) ?? null;
}

export function subscribeHomeGovernanceSnapshots(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Marks a load in flight. A Home that already has an observation goes to
 * `refreshing` and keeps it; only a Home that has never answered shows
 * `loading`. "This Home has no owner yet" is such an observation: it is kept
 * through the re-read, so the claim page does not flash a loading state.
 */
export function beginHomeGovernanceLoad(scope: ServerAccountScope): void {
    const current = getHomeGovernanceSnapshot(scope);
    const ownerless = current?.error?.code === 'home_governance_setup_required' ? current.error : null;
    const status: HomeGovernanceSnapshotStatus = current?.data || ownerless ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === ownerless) return;
    write(scope, Object.freeze({
        scope,
        status,
        data: current?.data ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: ownerless,
    }));
}

export function applyHomeGovernanceProjection(params: Readonly<{
    scope: ServerAccountScope;
    projection: HomeGovernanceProjectionV1;
    observedAt: number;
    current?: boolean;
}>): void {
    // An equal re-read keeps the projection's identity, so its readers see no change.
    write(params.scope, Object.freeze({
        scope: params.scope,
        status: 'ready',
        data: retainDeep(getHomeGovernanceSnapshot(params.scope)?.data ?? undefined, params.projection),
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
}

/** Marks one exact Account-scoped projection stale without touching siblings. */
export function invalidateHomeGovernanceSnapshot(scope: ServerAccountScope): boolean {
    const current = getHomeGovernanceSnapshot(scope);
    if (!current || current.stale) return false;
    snapshots.set(keyOf(scope), Object.freeze({ ...current, stale: true }));
    notify();
    return true;
}

/**
 * Records a failed observation. The last successful projection is retained and
 * marked stale so the surface keeps rendering truthfully with a retry, instead
 * of flashing an empty or unauthorized-looking Home.
 */
export function applyHomeGovernanceFailure(params: Readonly<{
    scope: ServerAccountScope;
    error: HomeGovernanceSnapshotError;
}>): void {
    const current = getHomeGovernanceSnapshot(params.scope);
    const reachability = reachabilityForScopedSnapshotError(params.error);
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    write(params.scope, Object.freeze({
        scope: params.scope,
        status: 'error',
        data: withdrawn ? null : current?.data ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        reachability,
        error: params.error,
    }));
}

/**
 * The Account-change wake seam. It only marks the exact Home's rows stale; the
 * projection is fully reconstructible, so a coalesced or missed wake is
 * harmless and no cursor, replay or polling timer is implied.
 */
export function invalidateHomeGovernanceSnapshotsForServer(serverIdRaw: string): boolean {
    const serverId = serverIdRaw.trim();
    if (!serverId) return false;
    let changed = false;
    for (const [key, snapshot] of snapshots) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        snapshots.set(key, Object.freeze({ ...snapshot, stale: true }));
        changed = true;
    }
    if (changed) notify();
    return changed;
}

/** Drops every Account's rows for one Home, for sign-out or credential change. */
export function clearHomeGovernanceSnapshotsForServer(serverIdRaw: string): void {
    const serverId = serverIdRaw.trim();
    if (!serverId) return;
    let changed = false;
    for (const [key, snapshot] of snapshots) {
        if (snapshot.scope.serverId !== serverId) continue;
        snapshots.delete(key);
        changed = true;
    }
    managedIdentityProviderObservations.clearForServer(serverId);
    managedGitHubAppsObservations.clearForServer(serverId);
    identityConnectionObservations.clearForServer(serverId);
    for (const [key, observation] of activityObservations) {
        if (observation.lifetime.scope.serverId === serverId) activityObservations.delete(key);
    }
    if (changed) notify();
}

/** Test-only reset of the module-owned projection cache. */
export function resetHomeGovernanceSnapshotsForTests(): void {
    snapshots.clear();
    activityObservations.clear();
    managedIdentityProviderObservations.clear();
    managedGitHubAppsObservations.clear();
    identityConnectionObservations.clear();
    listeners.clear();
}
