import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentLocalControlUiConfig } from '@/agents/registry/buildAgentLocalControlUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const CLAUDE_CORE: AgentCoreConfig = {
    id: 'claude',
    displayNameKey: 'agentInput.agent.claude',
    subtitleKey: 'profiles.aiBackend.claudeSubtitle',
    permissionModeI18nPrefix: 'agentInput.permissionMode',
    availability: { experimental: false },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'claude' }),
    uiConnectedService: { serviceId: 'anthropic', label: 'Claude Code', connectRoute: '/settings/connect/claude' },
    flavorAliases: ['claude'],
    cli: buildCatalogProviderCliUiConfig('claude'),
    permissions: {
        modeGroup: 'claude',
        promptProtocol: 'claude',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('claude'),
        staticOptions: [
            {
                id: 'default',
                nameKey: 'agentInput.mode.build',
                descriptionKey: 'agentInput.mode.buildDescription',
            },
            {
                id: 'plan',
                nameKey: 'agentInput.mode.plan',
                descriptionKey: 'agentInput.mode.planDescription',
            },
        ],
    },
    model: getAgentModelConfig('claude'),
    resume: buildAgentResumeUiConfig({
        agentId: 'claude',
        uiVendorResumeIdLabelKey: 'sessionInfo.claudeCodeSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.claudeCodeSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'claude' }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'claude' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'claude' }),
    ui: {
        agentPickerIconName: 'sparkles-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.14,
    },
};
