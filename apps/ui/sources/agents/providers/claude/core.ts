import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const CLAUDE_CORE: AgentCoreConfig = {
    id: 'claude',
    displayNameKey: 'agentInput.agent.claude',
    subtitleKey: 'profiles.aiBackend.claudeSubtitle',
    permissionModeI18nPrefix: 'agentInput.permissionMode',
    availability: { experimental: false },
    connectedService: {
        id: 'anthropic',
        name: 'Claude Code',
        connectRoute: '/(app)/settings/connect/claude',
    },
    flavorAliases: ['claude'],
    cli: {
        detectKey: 'claude',
        machineLoginKey: 'claude-code',
        installBanner: {
            installKind: 'ifAvailable',
            guideUrl: 'https://docs.anthropic.com/en/docs/claude-code/getting-started',
        },
        spawnAgent: 'claude',
    },
    permissions: {
        modeGroup: 'claude',
        promptProtocol: 'claude',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('claude'),
    },
    model: getAgentModelConfig('claude'),
    resume: {
        vendorResumeIdField: 'claudeSessionId',
        uiVendorResumeIdLabelKey: 'sessionInfo.claudeCodeSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.claudeCodeSessionIdCopied',
        supportsVendorResume: true,
        runtimeGate: null,
        experimental: false,
    },
    localControl: {
        supported: true,
    },
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    ui: {
        agentPickerIconName: 'sparkles-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.14,
    },
};
