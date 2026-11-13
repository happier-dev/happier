import * as React from 'react';
import type { RegistryUpstreamCheckV1 } from '@happier-dev/protocol/registries';
import type { RegistryUpdateCheckState } from '@/registries/useRegistryUpdateCheck';
import type { InstalledPluginActionId } from '@/components/settings/plugins/model/usePluginSettingsScreenState';
import { projectInstalledPluginLifecycleCapabilities } from '@/components/settings/plugins/model/pluginMarketplaceModel';
import type { InstalledPluginRow } from '../catalog/storeKinds';

type Subject = Pick<InstalledPluginRow, 'key' | 'detail'> & Readonly<{ native: Pick<InstalledPluginRow['native'], 'pluginId'> }>;
export type StorePluginUpdateEntry = Readonly<{
    key: string; pluginId: string;
    machineId?: string;
    state: 'unknown' | 'current' | 'available' | 'removed' | 'unchecked';
    observation: RegistryUpstreamCheckV1 | null;
    reason?: Extract<RegistryUpstreamCheckV1, { state: 'unchecked' }>['reason'];
    from: string | null;
    review?: Readonly<{ action: Extract<InstalledPluginActionId, 'update'>; pluginId: string }>;
}>;

/** Finite registry observations plus native Plugin review. No version inference, read, timer or install loop. */
export function useStorePluginUpdates(input: Readonly<{ rows: readonly Subject[]; check: RegistryUpdateCheckState }>) {
    const { rows, check } = input;
    return React.useMemo(() => {
        // Keep each daemon's observation qualified; a current sibling must not erase another placement's update.
        const observations = new Map<string, { machineId?: string; upstream: RegistryUpstreamCheckV1 }[]>();
        for (const result of check.results) {
            if (result.kind !== 'plugin') continue;
            const entries = observations.get(result.key);
            const observation = { machineId: result.machineId, upstream: result.upstream };
            if (entries) entries.push(observation); else observations.set(result.key, [observation]);
        }
        const entries = rows.flatMap((row): StorePluginUpdateEntry[] => {
            const pluginId = row.native.pluginId;
            const reported = observations.get(pluginId);
            return (reported?.length ? reported : [{ upstream: null }]).map((reported: Readonly<{ machineId?: string; upstream: RegistryUpstreamCheckV1 | null }>) => {
                const observation = reported.upstream;
                const machineId = reported.machineId;
                const state = observation?.state === 'update_available' ? 'available'
                    : observation?.state === 'removed_from_source' ? 'removed' : observation?.state ?? 'unknown';
                return { key: row.key, pluginId, machineId, state, observation,
                    ...(observation?.state === 'unchecked' ? { reason: observation.reason } : {}),
                    from: row.detail?.version ?? null,
                    ...(row.detail && projectInstalledPluginLifecycleCapabilities(row.detail).canUpdate
                        ? { review: { action: 'update', pluginId } } : {}) };
            });
        });
        const complete = check.checkedAt !== null && !check.failed
            && entries.every(entry => entry.state !== 'unknown' && entry.state !== 'unchecked');
        return { entries, count: complete ? entries.filter(entry => entry.state === 'available' || entry.state === 'removed').length : null };
    }, [rows, check]);
}
