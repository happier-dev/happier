import * as React from 'react';

import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { AGENT_IDS, type AgentId } from '@happier-dev/agents';

export type ProviderReadinessStatus = 'ready' | 'missing' | 'unknown';

export type ProviderReadinessPill = Readonly<{
    providerId: AgentId;
    status: ProviderReadinessStatus;
}>;

export type UseProviderReadinessInput = Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    providerIds?: readonly AgentId[];
}>;

const DEFAULT_PROVIDER_IDS = AGENT_IDS as readonly AgentId[];

function resolveProviderStatus(value: boolean | null | undefined): ProviderReadinessStatus {
    if (value === true) return 'ready';
    if (value === false) return 'missing';
    return 'unknown';
}

export function useProviderReadiness(input: UseProviderReadinessInput): ProviderReadinessPill[] {
    const providerIds = input.providerIds ?? DEFAULT_PROVIDER_IDS;
    const machineId = input.machineId ? String(input.machineId).trim() : '';
    const cli = useCLIDetection(machineId || null, {
        autoDetect: machineId.length > 0,
        agentIds: providerIds,
        serverId: input.serverId,
    });

    return React.useMemo(
        () => providerIds.map((providerId) => ({
            providerId,
            status: resolveProviderStatus(cli.available[providerId]),
        })),
        [cli.available, providerIds],
    );
}
