import type { TranslationKey } from '@/text';

import { AGENTS_CORE, type AgentId } from '@happier-dev/agents';

import type { AgentCoreConfig } from './registryCore';

export function buildAgentResumeUiConfig(params: Readonly<{
    agentId: AgentId;
    uiVendorResumeIdLabelKey: TranslationKey | null;
    uiVendorResumeIdCopiedKey: TranslationKey | null;
}>): AgentCoreConfig['resume'] {
    const resume = AGENTS_CORE[params.agentId]?.resume;
    const vendorResumeIdField = resume && 'vendorResumeIdField' in resume ? resume.vendorResumeIdField : null;

    return {
        vendorResumeIdField,
        uiVendorResumeIdLabelKey: params.uiVendorResumeIdLabelKey,
        uiVendorResumeIdCopiedKey: params.uiVendorResumeIdCopiedKey,
        supportsVendorResume: resume?.vendorResume === 'supported' || resume?.vendorResume === 'experimental',
        experimental: resume?.vendorResume === 'experimental',
    };
}
