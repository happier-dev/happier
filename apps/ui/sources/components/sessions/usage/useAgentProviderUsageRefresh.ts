import * as React from 'react';

import type { AgentId } from '@/agents/catalog/catalog';
import { useProfile } from '@/sync/domains/state/storage';

import { useProviderUsageGauges } from './useProviderUsageGauges';

/**
 * "Query all configured providers now" before any session exists (New Session). The gauge itself
 * comes from the composer's usage-gauge owner; this only supplies the refresh target.
 */
export function useAgentProviderUsageRefresh(agentId: AgentId | null | undefined): () => void {
    const accountProfile = useProfile();
    const agentIds = React.useMemo(() => (agentId ? [agentId] : []), [agentId]);
    const { refreshAgent } = useProviderUsageGauges({
        agentIds,
        accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
        windowMode: 'most_constrained',
        fetchEnabled: false,
    });
    return React.useCallback(() => {
        if (agentId) refreshAgent(agentId);
    }, [agentId, refreshAgent]);
}
