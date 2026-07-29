import * as React from 'react';

import type { AgentId } from '@/agents/registry/registryCore';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { buildResumeCapabilityOptionsFromUiState } from '@/agents/registry/registryUiBehavior';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { Settings } from '@/sync/domains/settings/settings';

export function useResumeCapabilityOptions(opts: {
    agentId?: AgentId | null;
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

    const resumeCapabilityOptions = React.useMemo(() => {
        const base = buildResumeCapabilityOptionsFromUiState({
            settings: opts.settings,
            results: undefined,
        });
        return {
            ...base,
            linkedSessionCurrentAgent,
        };
    }, [linkedSessionCurrentAgent, opts.settings]);

    return { resumeCapabilityOptions };
}
