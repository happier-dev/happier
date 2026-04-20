import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentLocalControlUiConfig } from '@/agents/registry/buildAgentLocalControlUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const KIRO_CORE: AgentCoreConfig = {
    id: 'kiro',
    displayNameKey: 'agentInput.agent.kiro',
    subtitleKey: 'profiles.aiBackend.kiroSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'kiro' }),
    uiConnectedService: { serviceId: null, label: 'Kiro', connectRoute: null },
    flavorAliases: ['kiro', 'kiro-cli'],
    cli: buildCatalogProviderCliUiConfig('kiro'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('kiro'),
    },
    model: getAgentModelConfig('kiro'),
    resume: buildAgentResumeUiConfig({
        agentId: 'kiro',
        uiVendorResumeIdLabelKey: 'sessionInfo.kiroSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.kiroSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'kiro' }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'kiro' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'kiro' }),
    ui: {
        agentPickerIconName: 'flash-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
    },
};
