import * as React from 'react';
import type { RegistryUpstreamCheckV1 } from '@happier-dev/protocol/registries';
import type { RegistryUpdateCheckState } from '@/registries/useRegistryUpdateCheck';
import type { InstalledPluginActionId } from '@/components/settings/plugins/model/usePluginSettingsScreenState';
import { projectInstalledPluginLifecycleCapabilities } from '@/components/settings/plugins/model/pluginMarketplaceModel';
import type { InstalledPluginRow } from '../catalog/storeKinds';

type Subject = Pick<InstalledPluginRow, 'key' | 'detail'> & Readonly<{ native: Pick<InstalledPluginRow['native'], 'pluginId'> }>;
export type StorePluginUpdateEntry = Readonly<{
    key: string; pluginId: string;
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
        const observations = new Map(check.results.filter(result => result.kind === 'plugin').map(result => [result.key, result.upstream]));
        const entries = rows.map((row): StorePluginUpdateEntry => {
            const pluginId = row.native.pluginId;
            const observation = observations.get(pluginId) ?? null;
            const state = observation?.state === 'update_available' ? 'available'
                : observation?.state === 'removed_from_source' ? 'removed' : observation?.state ?? 'unknown';
            return { key: row.key, pluginId, state, observation,
                ...(observation?.state === 'unchecked' ? { reason: observation.reason } : {}),
                from: row.detail?.version ?? null,
                ...(row.detail && projectInstalledPluginLifecycleCapabilities(row.detail).canUpdate
                    ? { review: { action: 'update', pluginId } } : {}) };
        });
        const complete = check.checkedAt !== null && !check.failed
            && entries.every(entry => entry.state !== 'unknown' && entry.state !== 'unchecked');
        return { entries, count: complete ? entries.filter(entry => entry.state === 'available' || entry.state === 'removed').length : null };
    }, [rows, check]);
}
