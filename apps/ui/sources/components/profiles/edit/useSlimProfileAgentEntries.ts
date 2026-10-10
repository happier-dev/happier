import * as React from 'react';

import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { useSettingsSelector } from '@/sync/domains/state/storage';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';

export function useSlimProfileAgentEntries(machineId: string | null, serverId?: string | null) {
    const enabledAgentIds = useEnabledAgentIds();
    const settings = useSettingsSelector((settings) => ({
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
    }));
    const resolvedServerId = serverId ?? getActiveServerId();
    const { snapshot: acpCatalog } = useAcpCatalogForServer(serverId === undefined ? resolvedServerId : serverId);
    const projection = useDaemonMergedProjectionInputs({
        machineId,
        serverId: resolvedServerId,
        enabled: Boolean(machineId),
        staleMs: 60_000,
    });
    const entries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSnapshot: acpCatalog?.catalog,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            discoveredBackendIds: projection.inputs?.discoveredBackendIds ?? undefined,
            mergedProviderProjectionById: projection.inputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: projection.inputs?.mergedBackendProjectionById ?? null,
        });
    }, [
        enabledAgentIds,
        projection.inputs?.discoveredBackendIds,
        projection.inputs?.mergedBackendProjectionById,
        projection.inputs?.mergedProviderProjectionById,
        acpCatalog,
        settings.backendEnabledByTargetKey,
    ]);
    return { entries, projection, serverId: resolvedServerId };
}
