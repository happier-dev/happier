import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentLocalControlUiConfig } from '@/agents/registry/buildAgentLocalControlUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const OPENCODE_CORE: AgentCoreConfig = {
    id: 'opencode',
    displayNameKey: 'agentInput.agent.opencode',
    subtitleKey: 'profiles.aiBackend.opencodeSubtitle',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: false },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'opencode' }),
    uiConnectedService: { serviceId: null, label: 'OpenCode', connectRoute: null },
    flavorAliases: ['opencode', 'open-code'],
    cli: buildCatalogProviderCliUiConfig('opencode'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('opencode'),
    },
    model: getAgentModelConfig('opencode'),
    resume: buildAgentResumeUiConfig({
        agentId: 'opencode',
        uiVendorResumeIdLabelKey: 'sessionInfo.opencodeSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.opencodeSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'opencode' }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'opencode' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'opencode' }),
    ui: {
        agentPickerIconName: 'code-slash-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
    },
};
