import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const COPILOT_CORE: AgentCoreConfig = {
    id: 'copilot',
    displayNameKey: 'agentInput.agent.copilot',
    subtitleKey: 'profiles.aiBackend.copilotSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: {
        id: null,
        name: 'Copilot',
        connectRoute: null,
    },
    flavorAliases: ['copilot', 'github-copilot', 'copilot-cli'],
    cli: {
        detectKey: 'copilot',
        machineLoginKey: 'copilot',
        installBanner: {
            installKind: 'command',
            installCommand: 'npm install -g @github/copilot',
        },
        spawnAgent: 'copilot',
    },
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('copilot'),
    },
    model: getAgentModelConfig('copilot'),
    resume: {
        vendorResumeIdField: 'copilotSessionId',
        uiVendorResumeIdLabelKey: 'sessionInfo.copilotSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.copilotSessionIdCopied',
        supportsVendorResume: false,
        runtimeGate: 'acpLoadSession',
        experimental: false,
    },
    toolRendering: {
        hideUnknownToolsByDefault: true,
    },
    ui: {
        agentPickerIconName: 'code-slash-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
    },
};
