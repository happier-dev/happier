import * as React from 'react';

import { readCurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { buildResumeCapabilityOptionsFromUiState } from '@/agents/registry/registryUiBehavior';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { Settings } from '@/sync/domains/settings/settings';

export function useResumeCapabilityOptions(opts: {
    agentId?: string | null;
    machineId: string | null | undefined;
    serverId?: string | null;
    settings: Settings;
    enabled?: boolean;
}): {
    resumeCapabilityOptions: ResumeCapabilityOptions;
} {
    const projection = useDaemonMergedProjectionInputs({
        machineId: opts.machineId,
        serverId: opts.serverId,
        enabled: opts.enabled !== false && opts.agentId !== null && opts.agentId !== undefined,
    });
    const linkedSessionCurrentAgent = React.useMemo(() => {
        if (projection.phase !== 'ready' || !opts.agentId) return null;
        const externalSessions = projection.inputs?.pluginProjectionV2
            ?.agentsById[opts.agentId]
            ?.externalSessions;
        if (!externalSessions) return null;
        return {
            identity: externalSessions.agent,
            sourceKinds: externalSessions.sources.map((source) => source.sourceKind),
        };
    }, [opts.agentId, projection.inputs, projection.phase]);
    const currentAgentCapabilities = React.useMemo(() => (
        projection.phase === 'ready'
            ? readCurrentProjectedAgentCapabilities({
                projection: projection.inputs?.pluginProjectionV2,
                agentId: opts.agentId,
            })
            : null
    ), [opts.agentId, projection.inputs?.pluginProjectionV2, projection.phase]);

    const resumeCapabilityOptions = React.useMemo(() => {
        const base = buildResumeCapabilityOptionsFromUiState({
            settings: opts.settings,
            results: undefined,
        });
        return {
            ...base,
            linkedSessionCurrentAgent,
            currentAgentCapabilities,
        };
    }, [currentAgentCapabilities, linkedSessionCurrentAgent, opts.settings]);

    return { resumeCapabilityOptions };
}
