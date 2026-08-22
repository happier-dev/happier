import { getAgentCore } from './manifest.js';
import type { AgentId, AgentRuntimeInputConfig, BundledAgentId } from './types.js';

const UNSUPPORTED_AGENT_RUNTIME_INPUT: AgentRuntimeInputConfig = Object.freeze({
    inFlightSteerSupported: false,
    terminalPromptInjectionSupported: false,
});

export function getAgentRuntimeInputCapability(agentId: BundledAgentId): AgentRuntimeInputConfig;
export function getAgentRuntimeInputCapability(agentId: AgentId): AgentRuntimeInputConfig | null;
export function getAgentRuntimeInputCapability(agentId: AgentId): AgentRuntimeInputConfig | null {
    const agent = getAgentCore(agentId);
    if (agent == null) {
        return null;
    }
    return agent.runtimeInput ?? UNSUPPORTED_AGENT_RUNTIME_INPUT;
}

export function supportsAgentInFlightSteer(agentId: AgentId): boolean {
    return getAgentRuntimeInputCapability(agentId)?.inFlightSteerSupported === true;
}

export function supportsAgentTerminalPromptInjection(agentId: AgentId): boolean {
    return getAgentRuntimeInputCapability(agentId)?.terminalPromptInjectionSupported === true;
}
