import * as React from 'react';

import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability';

import {
    getInstalledPluginReactNativeBundleCache,
} from '@/components/plugins/reactNative/bundleCache';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import {
    forgetPluginUiProjectionAdmissionSnapshots,
} from '@/sync/domains/plugins/ui/projectionWarmCache';

import {
    createPluginAccountAvailabilityReaderStore,
    projectPluginAccountAvailabilityMaterializationIdentity,
    type PluginAccountAvailabilityReader,
    type PluginAccountAvailabilityReleaseClassificationV1,
    type PluginAccountAvailabilitySnapshot,
} from './reader';

const readerStore = createPluginAccountAvailabilityReaderStore();

/** Imperative Account consumers use the same scoped projection as mounted surfaces. */
export function readPluginAccountAvailability(scope: ServerAccountScope): PluginAccountAvailabilityReader {
    return readerStore.bind(scope);
}

function currentProjectionLifetime(scope: ServerAccountScope): ActiveServerAccountScopeLifetime | null {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (
        !lifetime
        || !lifetime.isCurrent()
        || !areServerAccountScopesEqual(lifetime.scope, scope)
    ) return null;
    return lifetime;
}

/**
 * The sole UI projection writer. The Account Availability HTTP/change owner
 * replaces one complete verified snapshot; consumers only read Account
 * currentness/materialization facts and never write a URL, cache source, or
 * currentness decision into it.
 */
export function replacePluginAccountAvailabilityProjection(input: Readonly<{
    scope: ServerAccountScope;
    snapshot: PluginAccountAvailabilitySnapshot;
    failedPluginIds?: readonly string[];
}>): void {
    readerStore.replace(input);
    const lifetime = currentProjectionLifetime(input.scope);
    if (!lifetime) return;
    // Availability is the current Account projection owner. Binding the
    // incumbent Artifact custody here makes prior-run bytes retire even when no surface
    // acquires an Artifact during this app lifetime. Retiring reachability is
    // the whole transition: replacing this projection is never a deletion
    // authority, so `A -> B -> A` reuses retained bytes instead of paying for a
    // second download (PEP master decision 9; PEP-ARTIFACTS 8.2). Physical
    // deletion stays with logout/forget/explicit clear and with the Artifact custody owner's
    // corruption and eviction owners.
    getInstalledPluginReactNativeBundleCache().bindAccountLifetime(lifetime);
}

/**
 * Commits every successful per-plugin read before surfacing an incomplete
 * refresh to the existing sync retry owner.
 */
export function applyPluginAccountAvailabilityProjectionRefresh(input: Readonly<{
    scope: ServerAccountScope;
    snapshot: PluginAccountAvailabilitySnapshot;
    failedPluginIds: readonly string[];
}>): void {
    replacePluginAccountAvailabilityProjection(input);
    if (input.failedPluginIds.length > 0) {
        throw new Error(`Plugin Availability refresh failed for: ${input.failedPluginIds.join(', ')}`);
    }
}

/**
 * Logout, forget Account, or an explicit local clear. An Account switch or
 * deactivation only retires handles, projections and lookup authority — its
 * Account-qualified bytes may remain inert and are reusable once the same
 * Account and exact current release authority are re-established. Forgetting
 * the Account on this device is the one path that also deletes those bytes,
 * through the incumbent Artifact custody owner's Account cleanup and quarantine fence,
 * together with the Account's retained plugin UI admission snapshot: an index
 * entry that outlived a forgotten Account would still name its plugins.
 */
export function forgetPluginAccountAvailabilityArtifacts(scope: ServerAccountScope): void {
    clearPluginAccountAvailabilityProjection();
    forgetPluginUiProjectionAdmissionSnapshots(scope);
    // The Artifact custody owner fences the Account synchronously and owns the physical
    // deletion, its retry, and its quarantine. This adds no second cleanup
    // owner, timer or worker.
    void getInstalledPluginReactNativeBundleCache()
        .removePersistentArtifactsForAccount(scope)
        .catch(() => undefined);
}

/** Called by the incumbent Account-lifetime/reset owner through its consumer hook. */
export function clearPluginAccountAvailabilityProjection(): void {
    readerStore.clear();
}

/** An authoritative local withdrawal retires only the named plugins' authority. */
export function retirePluginAccountAvailabilityProjection(pluginIds: readonly string[]): void {
    readerStore.retire(pluginIds);
}

/**
 * The one app-facing injection point for Account Availability facts. A
 * returned reader is bound to the active Account realm, so a consumer cannot
 * accidentally pass a local server id or machine choice into currentness.
 */
export function useActivePluginAccountAvailabilityReader(): PluginAccountAvailabilityReader | null {
    const scope = useActiveServerAccountScope();
    const snapshot = React.useSyncExternalStore(readerStore.subscribe, readerStore.getSnapshot, readerStore.getSnapshot);
    const serverId = scope?.serverId ?? null;
    const accountId = scope?.accountId ?? null;

    React.useEffect(() => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        const subscription = lifetime.onRetire(clearPluginAccountAvailabilityProjection);
        return () => subscription.dispose();
    }, [accountId, serverId]);

    return React.useMemo(() => {
        if (!scope) return null;
        return readPluginAccountAvailability(scope);
    }, [accountId, snapshot, scope, serverId]);
}

/**
 * Availability's single classifier injection for Administration. An absent
 * Account projection is an explicit fail-closed release result, not a local
 * version or source fallback.
 */
export function useActivePluginAccountAvailabilityReleaseClassifier(): (
    materialization: PluginMachineMaterializationV1,
) => PluginAccountAvailabilityReleaseClassificationV1 {
    const reader = useActivePluginAccountAvailabilityReader();
    return React.useMemo(() => {
        if (reader) return reader.classifyRelease;
        return (materialization): PluginAccountAvailabilityReleaseClassificationV1 => Object.freeze({
            ...projectPluginAccountAvailabilityMaterializationIdentity(materialization),
            releaseContent: 'unknown',
            validation: Object.freeze({ kind: 'rejected', reason: 'unknown' }),
        });
    }, [reader]);
}
