import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { AgentModelsScreen } from '@/components/settings/agents/AgentModelsScreen';

function one(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export default function AgentModelsRoute() {
    const params = useLocalSearchParams<{
        agentId?: string | string[];
        agentTargetKey?: string | string[];
        runtimeAgentId?: string | string[];
        machineId?: string | string[];
    }>();
    const agentId = one(params.agentId);
    return (
        <AgentModelsScreen
            agentTargetKey={one(params.agentTargetKey) || `backend:${agentId}`}
            runtimeAgentId={one(params.runtimeAgentId) || agentId || null}
            preferredMachineId={one(params.machineId) || null}
        />
    );
}
