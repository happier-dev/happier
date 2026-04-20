import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const AUGGIE_CORE: AgentCoreConfig = {
    id: 'auggie',
    displayNameKey: 'agentInput.agent.auggie',
    subtitleKey: 'profiles.aiBackend.auggieSubtitle',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'auggie' }),
    uiConnectedService: { serviceId: null, label: 'Auggie', connectRoute: null },
    flavorAliases: ['auggie'],
    cli: buildCatalogProviderCliUiConfig('auggie'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('auggie'),
    },
    model: getAgentModelConfig('auggie'),
    resume: buildAgentResumeUiConfig({
        agentId: 'auggie',
        uiVendorResumeIdLabelKey: 'sessionInfo.auggieSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.auggieSessionIdCopied',
    }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'auggie' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'auggie' }),
    ui: {
        agentPickerIconName: 'sparkles',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
    },
};
