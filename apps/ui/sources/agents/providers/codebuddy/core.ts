import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentLocalControlUiConfig } from '@/agents/registry/buildAgentLocalControlUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const CODEBUDDY_CORE: AgentCoreConfig = {
    id: 'codebuddy',
    displayNameKey: 'agentInput.agent.codebuddy',
    subtitleKey: 'profiles.aiBackend.codebuddySubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'codebuddy' }),
    uiConnectedService: { serviceId: null, label: 'CodeBuddy', connectRoute: null },
    flavorAliases: ['codebuddy-code'],
    cli: buildCatalogProviderCliUiConfig('codebuddy'),
    permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
    sessionModes: { kind: getAgentSessionModesKind('codebuddy') },
    model: getAgentModelConfig('codebuddy'),
    resume: buildAgentResumeUiConfig({
        agentId: 'codebuddy',
        uiVendorResumeIdLabelKey: 'sessionInfo.codebuddySessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.codebuddySessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'codebuddy' }),
    toolRendering: { hideUnknownToolsByDefault: false },
    tools: buildAgentToolsUiConfig({ agentId: 'codebuddy' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'codebuddy' }),
    ui: { agentPickerIconName: 'code-slash-outline', cliGlyphScale: 1, profileCompatibilityGlyphScale: 1 },
};
