import * as React from 'react';

import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { DAEMON_AGENT_CATALOG_SECTIONS } from '@/agents/backendCatalog/agentCatalogSections';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { useSettingsSelector } from '@/sync/domains/state/storage';
import { useAcpCatalogDataForServer } from '@/sync/store/useAcpCatalog';

export function useSlimProfileAgentEntries(machineId: string | null, serverId?: string | null): {
    entries: ReturnType<typeof getResolvedBackendCatalogEntries>;
    projection: ReturnType<typeof useDaemonMergedProjectionInputs>;
    serverId: string;
} {
    const enabledAgentIds = useEnabledAgentIds();
    const settings = useSettingsSelector((settings) => ({
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
    }), ["backendEnabledByTargetKey"]);
    const resolvedServerId = serverId ?? getActiveServerId();
    const acpCatalog = useAcpCatalogDataForServer(serverId === undefined ? resolvedServerId : serverId);
    const projection = useDaemonMergedProjectionInputs({
        sections: DAEMON_AGENT_CATALOG_SECTIONS,
        machineId,
        serverId: resolvedServerId,
        enabled: Boolean(machineId),
    });
    const entries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            retainedAcpCatalogRecord: acpCatalog,
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
