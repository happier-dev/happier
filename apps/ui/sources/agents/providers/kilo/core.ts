import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const KILO_CORE: AgentCoreConfig = {
    id: 'kilo',
    displayNameKey: 'agentInput.agent.kilo',
    subtitleKey: 'profiles.aiBackend.kiloSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: {
        id: null,
        name: 'Kilo',
        connectRoute: null,
    },
    flavorAliases: ['kilo', 'kilocode'],
    cli: {
        detectKey: 'kilo',
        machineLoginKey: 'kilo',
        installBanner: {
            installKind: 'command',
            installCommand: 'npm install -g @kilocode/cli@latest',
        },
        spawnAgent: 'kilo',
    },
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('kilo'),
    },
    model: getAgentModelConfig('kilo'),
    resume: {
        vendorResumeIdField: 'kiloSessionId',
        uiVendorResumeIdLabelKey: 'sessionInfo.kiloSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.kiloSessionIdCopied',
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
