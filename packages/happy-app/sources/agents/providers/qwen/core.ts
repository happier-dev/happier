import type { AgentCoreConfig } from '@/agents/registryCore';

export const QWEN_CORE: AgentCoreConfig = {
    id: 'qwen',
    displayNameKey: 'agentInput.agent.qwen',
    subtitleKey: 'profiles.aiBackend.qwenSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: {
        id: null,
        name: 'Qwen',
        connectRoute: null,
    },
    flavorAliases: ['qwen', 'qwen-code'],
    cli: {
        detectKey: 'qwen',
        machineLoginKey: 'qwen',
        installBanner: {
            installKind: 'command',
            installCommand: 'npm install -g @qwenlm/qwen-code',
            guideUrl: 'https://qwenlm.github.io/qwen-code-docs/',
        },
        spawnAgent: 'qwen',
    },
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    model: {
        supportsSelection: false,
        defaultMode: 'default',
        allowedModes: ['default'],
    },
    resume: {
        vendorResumeIdField: 'qwenSessionId',
        uiVendorResumeIdLabelKey: 'sessionInfo.qwenSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.qwenSessionIdCopied',
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

