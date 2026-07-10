import {
    type AgentCore,
    type AgentId,
    type AgentResumeConfig,
    type CanonicalAgentId,
} from './types.js';
import { mergeAuthoredWithGeneratedAgentFacts } from './definitions/generatedFacts.js';
import type { ProviderConnectedServicesAdapter } from './runtime/adjunctAdapters/types.js';

export const DEFAULT_AGENT_ID: AgentId = 'claude';

const AUTHORED_CANONICAL_AGENTS_CORE = {} as const satisfies Partial<Record<CanonicalAgentId, AgentCore>>;

export const CANONICAL_AGENTS_CORE: Readonly<Record<CanonicalAgentId, AgentCore>> =
    mergeAuthoredWithGeneratedAgentFacts<AgentCore>({
        authored: AUTHORED_CANONICAL_AGENTS_CORE,
        label: 'agent core',
        readGenerated: (definition) => definition.core,
    });

export const AGENTS_CORE = CANONICAL_AGENTS_CORE;

export function getAgentCore(agentId: AgentId): AgentCore {
    return CANONICAL_AGENTS_CORE[agentId];
}

export function getProviderConnectedServicesAdapter(agentId: AgentId): ProviderConnectedServicesAdapter | null {
    const providerCore = getAgentCore(agentId);

    if (providerCore.cloudConnect == null && providerCore.connectedServices == null) {
        return null;
    }

    return {
        ...(providerCore.cloudConnect != null ? { cloudConnect: providerCore.cloudConnect } : {}),
        ...(providerCore.connectedServices != null ? { connectedServices: providerCore.connectedServices } : {}),
    };
}

export function getAgentResumeConfig(agentId: AgentId): AgentResumeConfig {
    return getAgentCore(agentId).resume;
}

export function isRuntimeCheckedExperimentalVendorResume(agentId: AgentId): boolean {
    const resume = getAgentResumeConfig(agentId);
    return resume.vendorResume === 'experimental' && resume.experimentalResumePolicy === 'runtime_checked';
}
