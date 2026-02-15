import * as React from 'react';

import { DEFAULT_AGENT_ID, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { sync } from '@/sync/sync';

export function useNewSessionAgentTypeState(params: Readonly<{
    enabledAgentIds: ReadonlyArray<AgentId>;
    lastUsedAgent: unknown;
    tempAgentType?: unknown;
}>): Readonly<{
    agentType: AgentId;
    setAgentType: React.Dispatch<React.SetStateAction<AgentId>>;
    handleAgentCycle: () => void;
}> {
    const [agentType, setAgentType] = React.useState<AgentId>(() => {
        const fromTemp = params.tempAgentType;
        if (isAgentId(fromTemp) && params.enabledAgentIds.includes(fromTemp)) {
            return fromTemp;
        }
        if (isAgentId(params.lastUsedAgent) && params.enabledAgentIds.includes(params.lastUsedAgent)) {
            return params.lastUsedAgent;
        }
        return params.enabledAgentIds[0] ?? DEFAULT_AGENT_ID;
    });

    React.useEffect(() => {
        if (params.enabledAgentIds.includes(agentType)) return;
        setAgentType(params.enabledAgentIds[0] ?? DEFAULT_AGENT_ID);
    }, [agentType, params.enabledAgentIds]);

    const handleAgentCycle = React.useCallback(() => {
        setAgentType((prev) => {
            const enabled = params.enabledAgentIds;
            if (enabled.length === 0) return prev;
            const idx = enabled.indexOf(prev);
            if (idx < 0) return enabled[0] ?? prev;
            return enabled[(idx + 1) % enabled.length] ?? prev;
        });
    }, [params.enabledAgentIds]);

    // Persist agent selection changes, but avoid no-op writes (especially on initial mount).
    // `sync.applySettings()` triggers a server POST, so only write when it actually changed.
    React.useEffect(() => {
        if (params.lastUsedAgent === agentType) return;
        sync.applySettings({ lastUsedAgent: agentType });
    }, [agentType, params.lastUsedAgent]);

    return { agentType, setAgentType, handleAgentCycle };
}

