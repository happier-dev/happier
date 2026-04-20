import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const GEMINI_CORE: AgentCoreConfig = {
    id: 'gemini',
    displayNameKey: 'agentInput.agent.gemini',
    subtitleKey: 'profiles.aiBackend.geminiSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.geminiPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'gemini' }),
    uiConnectedService: { serviceId: 'gemini', label: 'Google Gemini', connectRoute: null },
    flavorAliases: ['gemini'],
    cli: buildCatalogProviderCliUiConfig('gemini'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('gemini'),
    },
    model: getAgentModelConfig('gemini'),
    resume: buildAgentResumeUiConfig({
        agentId: 'gemini',
        uiVendorResumeIdLabelKey: 'sessionInfo.geminiSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.geminiSessionIdCopied',
    }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'gemini' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'gemini' }),
    ui: {
        agentPickerIconName: 'planet-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 0.88,
    },
};
