import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const COPILOT_CORE: AgentCoreConfig = {
    id: 'copilot',
    displayNameKey: 'agentInput.agent.copilot',
    subtitleKey: 'profiles.aiBackend.copilotSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'copilot' }),
    uiConnectedService: { serviceId: null, label: 'Copilot', connectRoute: null },
    flavorAliases: ['copilot', 'github-copilot', 'copilot-cli'],
    cli: buildCatalogProviderCliUiConfig('copilot'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('copilot'),
    },
    model: getAgentModelConfig('copilot'),
    resume: buildAgentResumeUiConfig({
        agentId: 'copilot',
        uiVendorResumeIdLabelKey: 'sessionInfo.copilotSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.copilotSessionIdCopied',
    }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'copilot' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'copilot' }),
    ui: {
        agentPickerIconName: 'code-slash-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
    },
};
