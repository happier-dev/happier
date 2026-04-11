import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const OH_MY_PI_CORE: AgentCoreConfig = {
    id: 'ohMyPi',
    displayNameKey: 'agentInput.agent.ohMyPi',
    subtitleKey: 'profiles.aiBackend.ohMyPiSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: {
        id: null,
        name: 'oh-my-pi',
        connectRoute: null,
    },
    flavorAliases: ['ohMyPi', 'oh-my-pi', 'omp'],
    cli: buildCatalogProviderCliUiConfig('ohMyPi'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('ohMyPi'),
    },
    model: getAgentModelConfig('ohMyPi'),
    resume: buildAgentResumeUiConfig({
        agentId: 'ohMyPi',
        uiVendorResumeIdLabelKey: null,
        uiVendorResumeIdCopiedKey: null,
    }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'ohMyPi' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'ohMyPi' }),
    ui: {
        agentPickerIconName: 'planet-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
    },
};
