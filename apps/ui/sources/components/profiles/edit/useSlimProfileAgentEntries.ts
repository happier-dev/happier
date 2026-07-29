import * as React from 'react';

import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { useSettings } from '@/sync/domains/state/storage';

export function useSlimProfileAgentEntries(machineId: string | null) {
    const enabledAgentIds = useEnabledAgentIds();
    const settings = useSettings();
    const serverId = getActiveServerId();
    const projection = useDaemonMergedProjectionInputs({
        machineId,
        serverId,
        enabled: Boolean(machineId),
        staleMs: 60_000,
    });
    const entries = React.useMemo(() => getResolvedBackendCatalogEntries({
        enabledAgentIds,
        acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
        discoveredBackendIds: projection.inputs?.discoveredBackendIds ?? undefined,
        mergedProviderProjectionById: projection.inputs?.mergedProviderProjectionById ?? null,
        mergedBackendProjectionById: projection.inputs?.mergedBackendProjectionById ?? null,
    }), [
        enabledAgentIds,
        projection.inputs?.discoveredBackendIds,
        projection.inputs?.mergedBackendProjectionById,
        projection.inputs?.mergedProviderProjectionById,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
    ]);
    return { entries, projection, serverId };
}
