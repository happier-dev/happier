import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const QWEN_CORE: AgentCoreConfig = {
    id: 'qwen',
    displayNameKey: 'agentInput.agent.qwen',
    subtitleKey: 'profiles.aiBackend.qwenSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'qwen' }),
    uiConnectedService: { serviceId: null, label: 'Qwen', connectRoute: null },
    flavorAliases: ['qwen', 'qwen-code'],
    cli: buildCatalogProviderCliUiConfig('qwen'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('qwen'),
    },
    model: getAgentModelConfig('qwen'),
    resume: buildAgentResumeUiConfig({
        agentId: 'qwen',
        uiVendorResumeIdLabelKey: 'sessionInfo.qwenSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.qwenSessionIdCopied',
    }),
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'qwen' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'qwen' }),
    ui: {
        agentPickerIconName: 'code-slash-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
    },
};
