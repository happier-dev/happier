import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const KIMI_CORE: AgentCoreConfig = {
    id: 'kimi',
    displayNameKey: 'agentInput.agent.kimi',
    subtitleKey: 'profiles.aiBackend.kimiSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: {
        id: null,
        name: 'Kimi',
        connectRoute: null,
    },
    flavorAliases: ['kimi', 'kimi-cli'],
    cli: {
        detectKey: 'kimi',
        machineLoginKey: 'kimi',
        installBanner: {
            installKind: 'ifAvailable',
            guideUrl: 'https://kimi.moonshot.cn/docs/cli',
        },
        spawnAgent: 'kimi',
    },
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('kimi'),
    },
    model: getAgentModelConfig('kimi'),
    resume: {
        vendorResumeIdField: 'kimiSessionId',
        uiVendorResumeIdLabelKey: 'sessionInfo.kimiSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.kimiSessionIdCopied',
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
