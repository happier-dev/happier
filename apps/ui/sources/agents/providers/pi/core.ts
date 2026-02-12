import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

import type { AgentCoreConfig } from '@/agents/registry/registryCore';

export const PI_CORE: AgentCoreConfig = {
    id: 'pi',
    displayNameKey: 'agentInput.agent.pi',
    subtitleKey: 'profiles.aiBackend.piSubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedService: {
        id: null,
        name: 'Pi',
        connectRoute: null,
    },
    flavorAliases: ['pi', 'pi-coding-agent'],
    cli: {
        detectKey: 'pi',
        machineLoginKey: 'pi',
        installBanner: {
            installKind: 'command',
            installCommand: 'npm install -g @mariozechner/pi-coding-agent@latest',
            guideUrl: 'https://github.com/badlogic/pi-mono',
        },
        spawnAgent: 'pi',
    },
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('pi'),
    },
    model: getAgentModelConfig('pi'),
    resume: {
        vendorResumeIdField: 'piSessionId',
        uiVendorResumeIdLabelKey: 'sessionInfo.piSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.piSessionIdCopied',
        supportsVendorResume: false,
        runtimeGate: null,
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
