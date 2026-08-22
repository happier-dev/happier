import {
    isBundledAgentId,
    type AgentCore,
    type AgentId,
    type AgentResumeConfig,
    type BundledAgentId,
    type CanonicalAgentId,
} from './types.js';
import { mergeAuthoredWithGeneratedAgentFacts } from './definitions/generatedFacts.js';
import type { ProviderConnectedServicesAdapter } from './runtime/adjunctAdapters/types.js';

export const DEFAULT_AGENT_ID: BundledAgentId = 'claude';

const AUTHORED_CANONICAL_AGENTS_CORE = {} as const satisfies Partial<Record<CanonicalAgentId, AgentCore>>;

export const CANONICAL_AGENTS_CORE: Readonly<Record<CanonicalAgentId, AgentCore>> =
    mergeAuthoredWithGeneratedAgentFacts<AgentCore>({
        authored: AUTHORED_CANONICAL_AGENTS_CORE,
        label: 'agent core',
        readGenerated: (definition) => definition.core,
    });

export const AGENTS_CORE = CANONICAL_AGENTS_CORE;

/**
 * Bundled Agent facts for `agentId`, or `null` when the Agent is not bundled.
 *
 * An externally installed Agent has no entry here: its facts come from its own
 * plugin contribution. Reporting `null` keeps that case a typed unavailable
 * instead of borrowing another Agent's facts.
 */
export function getAgentCore(agentId: BundledAgentId): AgentCore;
export function getAgentCore(agentId: AgentId): AgentCore | null;
export function getAgentCore(agentId: AgentId): AgentCore | null {
    return isBundledAgentId(agentId) ? CANONICAL_AGENTS_CORE[agentId] : null;
}

export function getProviderConnectedServicesAdapter(agentId: AgentId): ProviderConnectedServicesAdapter | null {
    const providerCore = getAgentCore(agentId);
    if (providerCore == null) {
        return null;
    }

    if (providerCore.cloudConnect == null && providerCore.connectedServices == null) {
        return null;
    }

    return {
        ...(providerCore.cloudConnect != null ? { cloudConnect: providerCore.cloudConnect } : {}),
        ...(providerCore.connectedServices != null ? { connectedServices: providerCore.connectedServices } : {}),
    };
}

export function getAgentResumeConfig(agentId: BundledAgentId): AgentResumeConfig;
export function getAgentResumeConfig(agentId: AgentId): AgentResumeConfig | null;
export function getAgentResumeConfig(agentId: AgentId): AgentResumeConfig | null {
    return getAgentCore(agentId)?.resume ?? null;
}

export function isRuntimeCheckedExperimentalVendorResume(agentId: AgentId): boolean {
    const resume = getAgentResumeConfig(agentId);
    return resume?.vendorResume === 'experimental' && resume.experimentalResumePolicy === 'runtime_checked';
}
