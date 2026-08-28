import * as React from 'react';

import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';

/** Session-chrome adapter onto the canonical machine-scoped Agent catalog. */
export function SessionAgentCatalogIdentityIcon(props: Readonly<{
    agentId: string;
    machineId: string | null;
    serverId: string | null;
    color: string;
    size?: number;
    testID?: string;
}>): React.ReactElement {
    const projection = useDaemonMergedProjectionInputs({
        machineId: props.machineId,
        serverId: props.serverId,
        enabled: props.machineId !== null,
    });
    const entry = React.useMemo(() => resolveAgentCatalogProjection(props.agentId, {
        enabledAgentIds: [],
        mergedBackendProjectionById: projection.inputs?.mergedBackendProjectionById ?? null,
        mergedProviderProjectionById: projection.inputs?.mergedProviderProjectionById ?? null,
    }), [
        projection.inputs?.mergedBackendProjectionById,
        projection.inputs?.mergedProviderProjectionById,
        props.agentId,
    ]);

    return (
        <AgentCatalogIdentityIcon
            entry={entry}
            machineId={props.machineId}
            serverId={props.serverId}
            current={projection.phase === 'ready'}
            color={props.color}
            size={props.size}
            testID={props.testID}
        />
    );
}
