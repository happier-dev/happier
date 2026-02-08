import type { AgentCoreConfig } from '@/agents/registryCore';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const OPENCODE_CORE: AgentCoreConfig = {
    id: 'opencode',
    displayNameKey: 'agentInput.agent.opencode',
    subtitleKey: 'profiles.aiBackend.opencodeSubtitle',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: false },
    connectedService: {
        id: null,
        name: 'OpenCode',
        connectRoute: null,
    },
    flavorAliases: ['opencode', 'open-code'],
    cli: {
        detectKey: 'opencode',
        machineLoginKey: 'opencode',
        installBanner: {
            installKind: 'command',
            installCommand: 'curl -fsSL https://opencode.ai/install | bash',
            guideUrl: 'https://opencode.ai/docs',
        },
        spawnAgent: 'opencode',
    },
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('opencode'),
    },
    model: getAgentModelConfig('opencode'),
    resume: {
        vendorResumeIdField: 'opencodeSessionId',
        uiVendorResumeIdLabelKey: 'sessionInfo.opencodeSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.opencodeSessionIdCopied',
        supportsVendorResume: false,
        runtimeGate: 'acpLoadSession',
        experimental: false,
    },
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    ui: {
        agentPickerIconName: 'code-slash-outline',
        cliGlyphScale: 1.0,
        profileCompatibilityGlyphScale: 1.0,
    },
};
