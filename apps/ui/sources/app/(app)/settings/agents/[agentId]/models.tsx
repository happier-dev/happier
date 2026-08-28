import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { AgentModelsScreen } from '@/components/settings/agents/AgentModelsScreen';
import { resolveAgentModelsTargetKey } from '@/agents/catalog/agentSettingsRoutes';

function one(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export default function AgentModelsRoute() {
    const params = useLocalSearchParams<{
        agentId?: string | string[];
        pluginId?: string | string[];
        agentTargetKey?: string | string[];
        runtimeAgentId?: string | string[];
    }>();
    const agentId = one(params.agentId);
    return (
        <AgentModelsScreen
            agentTargetKey={resolveAgentModelsTargetKey({
                agentId,
                pluginId: one(params.pluginId),
                agentTargetKey: one(params.agentTargetKey),
            })}
            runtimeAgentId={one(params.runtimeAgentId) || agentId || null}
        />
    );
}
