import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';

import { getCachedServerFeaturesSnapshot, getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { createScopedSnapshotLoader } from '@/sync/engine/scope/scopedSnapshotLoader';
import { refreshMachinePools } from '@/sync/ops/machinePools';
import { isHomeAdministrationAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

type MachinePoolProjectionTarget = Readonly<{
    key: string;
    serverId: string;
    forceFeatures: boolean;
}>;

const forceFeatureRefreshByServerId = new Set<string>();

// The Pool store, credentials and Actions key a Home by its portable scope id; callers may pass the
// local profile id, so every entry point resolves to the scope id before keying the loader.
const targetFor = (serverIdRaw: string, forceFeatures: boolean): MachinePoolProjectionTarget => {
    const serverId = resolveServerProfileScopeIdForIdentifier(serverIdRaw) || serverIdRaw;
    return { key: serverId, serverId, forceFeatures };
};

const loader = createScopedSnapshotLoader<MachinePoolProjectionTarget>({
    // Focused Pool writes already refresh this owner through the awaited change planner.
    // Preserve Account/configuration and content-free recovery wakes without also replaying
    // every unrelated exact page (or issuing a second refresh for the same Pool write).
    matchesWake: isHomeAdministrationAccountChange,
    load: async (target, context) => {
        const forceFeaturesRequested = forceFeatureRefreshByServerId.delete(target.serverId);
        const forceFeatures = target.forceFeatures || forceFeaturesRequested;
        if (forceFeatures) {
            const featureSnapshot = await getServerFeaturesSnapshot({ serverId: target.serverId, force: true });
            // Missing, malformed and disabled feature state fails closed. Wakes may discover a
            // newly enabled Home, but never send an unsupported Pool Action speculatively.
            if (
                featureSnapshot.status !== 'ready'
                || readServerEnabledBit(featureSnapshot.features, 'machines.pools') !== true
            ) return;
        }
        await refreshMachinePools(target.serverId);
        if (!context.isCurrent()) {
            // The answer remains useful as last-known data, but a mutation landed after the request
            // began. Keep it inert until the loader-owned trailing request publishes current rows.
            storage.getState().setMachinePoolListStatus(target.serverId, 'loading');
        }
    },
    shouldLoadOnObserve: (target) => {
        const snapshot = getCachedServerFeaturesSnapshot({ serverId: target.serverId });
        if (
            snapshot?.status !== 'ready'
            || readServerEnabledBit(snapshot.features, 'machines.pools') !== true
        ) return false;
        const state = storage.getState();
        return !Array.isArray(state.machinePoolListByServerId[target.serverId])
            || state.machinePoolListStatusByServerId[target.serverId] !== 'idle';
    },
    invalidateServer: (serverId) => {
        storage.getState().setMachinePoolListStatus(serverId, 'loading');
    },
    invalidateTarget: (target) => {
        storage.getState().setMachinePoolListStatus(target.serverId, 'loading');
    },
    onCredentialMutation: (event, target) => {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, target.serverId)) return false;
        if (event.kind === 'credentials_removed') {
            // Keep this Account's last-known rows for continuity while withdrawing selection.
            storage.getState().setMachinePoolListStatus(target.serverId, 'signedOut');
            return false;
        }
        // A replacement can select another Account on this Home. Remove the previous Account's
        // private definitions before resolving the new credential through the same loader.
        storage.getState().clearMachinePoolsForServer(target.serverId);
        storage.getState().setMachinePoolListStatus(target.serverId, 'loading');
        forceFeatureRefreshByServerId.add(target.serverId);
        return true;
    },
});

export function observeMachinePoolProjection(serverIdRaw: string): () => void {
    const serverId = serverIdRaw.trim();
    return serverId ? loader.observe(targetFor(serverId, true)) : () => {};
}

/**
 * Explicit command/action invalidation. Unlike a user retry, this guarantees a trailing request
 * when the invalidation lands during an older request, so a change checkpoint cannot acknowledge
 * the pre-change projection.
 */
export function invalidateMachinePoolProjection(
    serverIdRaw: string,
    options: Readonly<{ forceFeatures?: boolean }> = {},
): Promise<void> {
    const serverId = serverIdRaw.trim();
    if (!serverId) return Promise.resolve();
    const target = targetFor(serverId, options.forceFeatures === true);
    if (options.forceFeatures) forceFeatureRefreshByServerId.add(target.serverId);
    return loader.invalidate(target);
}

/** Observation-time hydration and user retry join an already current in-flight request. */
export function refreshMachinePoolProjection(serverIdRaw: string): Promise<void> {
    const serverId = serverIdRaw.trim();
    return serverId ? loader.refresh(targetFor(serverId, false)) : Promise.resolve();
}

export function resetMachinePoolProjectionForTests(): void {
    loader.resetForTests();
    forceFeatureRefreshByServerId.clear();
}
