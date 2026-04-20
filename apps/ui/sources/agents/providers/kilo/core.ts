import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const KILO_CORE: AgentCoreConfig = {
    id: 'kilo',
    displayNameKey: 'agentInput.agent.kilo',
    subtitleKey: 'profiles.aiBackend.kiloSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'kilo' }),
    uiConnectedService: { serviceId: null, label: 'Kilo', connectRoute: null },
    flavorAliases: ['kilo', 'kilocode'],
    cli: buildCatalogProviderCliUiConfig('kilo'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('kilo'),
    },
    model: getAgentModelConfig('kilo'),
    resume: buildAgentResumeUiConfig({
        agentId: 'kilo',
        uiVendorResumeIdLabelKey: 'sessionInfo.kiloSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.kiloSessionIdCopied',
    }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'kilo' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'kilo' }),
    ui: {
        agentPickerIconName: 'code-slash-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
    },
};
