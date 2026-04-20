import type { TranslationKey } from '@/text';

import { getAgentResumeConfig, type AgentId } from '@happier-dev/agents';

import type { AgentCoreConfig } from './registryCore';

export function buildAgentResumeUiConfig(params: Readonly<{
    agentId: AgentId;
    uiVendorResumeIdLabelKey: TranslationKey | null;
    uiVendorResumeIdCopiedKey: TranslationKey | null;
}>): AgentCoreConfig['resume'] {
    let resume: ReturnType<typeof getAgentResumeConfig> | null = null;
    try {
        resume = getAgentResumeConfig(params.agentId);
    } catch {
        resume = null;
    }
    const vendorResumeIdField = resume && 'vendorResumeIdField' in resume
        ? (resume.vendorResumeIdField ?? null)
        : null;

    return {
        vendorResumeIdField,
        uiVendorResumeIdLabelKey: params.uiVendorResumeIdLabelKey,
        uiVendorResumeIdCopiedKey: params.uiVendorResumeIdCopiedKey,
        supportsVendorResume: resume?.vendorResume === 'supported' || resume?.vendorResume === 'experimental',
        experimental: resume?.vendorResume === 'experimental',
    };
}
