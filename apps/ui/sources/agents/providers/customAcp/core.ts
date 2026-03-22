import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const CUSTOM_ACP_CORE: AgentCoreConfig = {
    id: 'customAcp',
    displayNameKey: 'agentInput.agent.customAcp',
    subtitleKey: 'profiles.aiBackend.customAcpSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: {
        id: null,
        name: 'Custom ACP',
        connectRoute: null,
    },
    flavorAliases: ['customAcp', 'custom-acp'],
    cli: buildCatalogProviderCliUiConfig('customAcp'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('customAcp'),
    },
    model: getAgentModelConfig('customAcp'),
    resume: buildAgentResumeUiConfig({
        agentId: 'customAcp',
        uiVendorResumeIdLabelKey: 'sessionInfo.customAcpSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.customAcpSessionIdCopied',
    }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'customAcp' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'customAcp' }),
    ui: {
        agentPickerIconName: 'git-network-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
    },
};
