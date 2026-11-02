import * as React from 'react';
import { BUNDLED_PLUGIN_UI_APP_DECLARATIONS } from './generatedBundledPluginUiArtifacts';

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
    type PluginAccountUiProjectionInputs,
} from './reader';

const readerStore = createPluginAccountAvailabilityReaderStore({
    loadHostBundledUi: () => {
        if (!BUNDLED_PLUGIN_UI_APP_DECLARATIONS) throw new Error('Bundled Plugin UI declarations are not prepared');
        return BUNDLED_PLUGIN_UI_APP_DECLARATIONS;
    },
});

function subscribeToReactProjection(listener: () => void): () => void {
    // Account capture can clear the store while a sibling renders. Withdraw
    // imperative authority synchronously, but notify React after that render;
    // the listener then reads the latest snapshot, including any successor.
    return readerStore.subscribe(() => queueMicrotask(listener));
}

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
    intentCensusIncomplete?: boolean;
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
    intentCensusIncomplete?: boolean;
}>): void {
    replacePluginAccountAvailabilityProjection(input);
    if (input.failedPluginIds.length > 0) {
        throw new Error(`Plugin Availability refresh failed for: ${input.failedPluginIds.join(', ')}`);
    }
    if (input.intentCensusIncomplete) {
        throw new Error('Plugin Availability intent census is incomplete.');
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
export function useActivePluginAccountAvailabilityReader(pluginId?: string,
    options?: Readonly<{ enabled?: boolean }>): PluginAccountAvailabilityReader | null {
    return usePluginAccountAvailabilityReader(undefined, pluginId, options);
}

/** Explicit readers retain native scope-mismatch admission instead of borrowing the focused Account. */
export function usePluginAccountAvailabilityReader(requestedScope: ServerAccountScope | null | undefined, pluginId?: string,
    options?: Readonly<{ enabled?: boolean }>): PluginAccountAvailabilityReader | null {
    const activeScope = useActiveServerAccountScope();
    const scope = requestedScope === undefined ? activeScope : requestedScope;
    const readSnapshot = React.useCallback(() => readerStore.getObservationSnapshot(pluginId), [pluginId]);
    const enabled = options?.enabled !== false;
    const subscribe = React.useCallback((listener: () => void) => {
        if (!enabled) return noAvailabilitySubscription();
        if (scope && pluginId !== undefined) {
            return readPluginAccountAvailability(scope).subscribe(() => queueMicrotask(listener), pluginId);
        }
        return subscribeToReactProjection(listener);
    }, [enabled, pluginId, scope]);
    const snapshot = React.useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
    const serverId = scope?.serverId ?? null;
    const accountId = scope?.accountId ?? null;

    useAvailabilityScopeRetirement(accountId, serverId);

    return React.useMemo(() => {
        if (!scope) return null;
        // Preserve this hook's publication revision for existing memoized
        // consumers; its methods remain the canonical scope-bound live readers.
        return Object.freeze({ ...readPluginAccountAvailability(scope) });
    }, [accountId, snapshot, scope, serverId]);
}

function noAvailabilitySubscription(): () => void { return () => {}; }

function useAvailabilityScopeRetirement(accountId: string | null, serverId: string | null): void {
    React.useEffect(() => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        const subscription = lifetime.onRetire(clearPluginAccountAvailabilityProjection);
        return () => subscription.dispose();
    }, [accountId, serverId]);
}

/** Descriptive App/UI consumers do not subscribe to transport observation revisions. */
export function useActivePluginAccountUiProjectionInputs(): PluginAccountUiProjectionInputs | null {
    const scope = useActiveServerAccountScope();
    useAvailabilityScopeRetirement(scope?.accountId ?? null, scope?.serverId ?? null);
    const readSnapshot = React.useCallback(() => scope
        ? readPluginAccountAvailability(scope).readUiProjectionInputs() : null, [scope]);
    return React.useSyncExternalStore(subscribeToReactProjection, readSnapshot, readSnapshot);
}

/**
 * Availability's single classifier injection for Administration. An absent
 * Account projection is an explicit fail-closed release result, not a local
 * version or source fallback.
 */
export function useActivePluginAccountAvailabilityReleaseClassifier(pluginId?: string): (
    materialization: PluginMachineMaterializationV1,
) => PluginAccountAvailabilityReleaseClassificationV1 {
    const reader = useActivePluginAccountAvailabilityReader(pluginId);
    return reader?.classifyRelease ?? classifyUnavailableRelease;
}

function classifyUnavailableRelease(materialization: PluginMachineMaterializationV1): PluginAccountAvailabilityReleaseClassificationV1 {
    return Object.freeze({
        ...projectPluginAccountAvailabilityMaterializationIdentity(materialization),
        releaseContent: 'unknown',
        validation: Object.freeze({ kind: 'rejected', reason: materialization.portableRelease ? 'release_unavailable' : 'non_portable' }),
    });
}
