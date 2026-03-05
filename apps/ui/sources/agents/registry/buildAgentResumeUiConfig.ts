import type { TranslationKey } from '@/text';

import { AGENTS_CORE, type AgentId } from '@happier-dev/agents';

import type { AgentCoreConfig } from './registryCore';

export function buildAgentResumeUiConfig(params: Readonly<{
    agentId: AgentId;
    uiVendorResumeIdLabelKey: TranslationKey | null;
    uiVendorResumeIdCopiedKey: TranslationKey | null;
}>): AgentCoreConfig['resume'] {
    const resume = AGENTS_CORE[params.agentId]?.resume;

    return {
        vendorResumeIdField: resume?.vendorResumeIdField ?? null,
        uiVendorResumeIdLabelKey: params.uiVendorResumeIdLabelKey,
        uiVendorResumeIdCopiedKey: params.uiVendorResumeIdCopiedKey,
        supportsVendorResume: resume?.vendorResume !== 'unsupported',
        runtimeGate: resume?.runtimeGate ?? null,
        experimental: resume?.vendorResume === 'experimental',
    };
}

