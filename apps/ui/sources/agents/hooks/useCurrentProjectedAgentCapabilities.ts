import * as React from 'react';

import {
    readCurrentProjectedAgentCapabilities,
    type CurrentProjectedAgentCapabilities,
} from '@/agents/backendCatalog/currentAgentCapabilities';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';

/**
 * Reads a lifecycle declaration only while the machine's daemon projection is
 * current. This is a transport adapter, not another capability owner.
 */
export function useCurrentProjectedAgentCapabilities(params: Readonly<{
    agentId: string | null | undefined;
    machineId: string | null | undefined;
    serverId?: string | null;
    enabled?: boolean;
}>): CurrentProjectedAgentCapabilities | null {
    const projection = useDaemonMergedProjectionInputs({
        machineId: params.machineId,
        serverId: params.serverId,
        enabled: params.enabled !== false && params.agentId !== null && params.agentId !== undefined,
    });

    return React.useMemo(() => (
        projection.phase === 'ready'
            ? readCurrentProjectedAgentCapabilities({
                projection: projection.inputs?.pluginProjectionV2,
                agentId: params.agentId,
            })
            : null
    ), [params.agentId, projection.inputs?.pluginProjectionV2, projection.phase]);
}
