import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentLocalControlUiConfig } from '@/agents/registry/buildAgentLocalControlUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';

export const CODEX_CORE: AgentCoreConfig = {
    id: 'codex',
    displayNameKey: 'agentInput.agent.codex',
    subtitleKey: 'profiles.aiBackend.codexSubtitle',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: false },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'codex' }),
    uiConnectedService: { serviceId: 'openai', label: 'OpenAI Codex', connectRoute: null },
    // Persisted metadata has used a few aliases over time.
    flavorAliases: ['codex', 'openai', 'gpt'],
    cli: buildCatalogProviderCliUiConfig('codex'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('codex'),
    },
    model: getAgentModelConfig('codex'),
    resume: buildAgentResumeUiConfig({
        agentId: 'codex',
        uiVendorResumeIdLabelKey: 'sessionInfo.codexSessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.codexSessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'codex' }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'codex' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'codex' }),
    ui: {
        agentPickerIconName: 'terminal-outline',
        cliGlyphScale: 0.92,
        profileCompatibilityGlyphScale: 0.82,
    },
};
