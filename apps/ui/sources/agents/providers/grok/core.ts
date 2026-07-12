import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentLocalControlUiConfig } from '@/agents/registry/buildAgentLocalControlUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const GROK_CORE: AgentCoreConfig = {
    id: 'grok',
    displayNameKey: 'agentInput.agent.grok',
    subtitleKey: 'profiles.aiBackend.grokSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'grok' }),
    uiConnectedService: { serviceId: null, label: 'Grok Build', connectRoute: null },
    flavorAliases: ['grok', 'grok-build', 'grok-cli'],
    cli: buildCatalogProviderCliUiConfig('grok'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('grok'),
    },
    model: getAgentModelConfig('grok'),
    resume: buildAgentResumeUiConfig({
        agentId: 'grok',
        uiVendorResumeIdLabelKey: 'sessionInfo.grokSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.grokSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'grok' }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'grok' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'grok' }),
    ui: {
        // A neutral host glyph is used until the exact official xAI asset can be downloaded and
        // byte-proven; xAI's current brand terms prohibit altering or recreating its mark.
        agentPickerIconName: 'flash-outline',
        cliGlyphScale: 0.9,
        profileCompatibilityGlyphScale: 0.9,
    },
};
