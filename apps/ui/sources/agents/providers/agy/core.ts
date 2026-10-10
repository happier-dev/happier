import type { AgentCoreConfig } from '@/agents/registry/registryCore';
import { buildCatalogProviderCliUiConfig } from '@/agents/providers/shared/buildCatalogProviderCliUiConfig';
import { buildAgentConnectedServicesUiConfig } from '@/agents/registry/buildAgentConnectedServicesUiConfig';
import { buildAgentLocalControlUiConfig } from '@/agents/registry/buildAgentLocalControlUiConfig';
import { buildAgentResumeUiConfig } from '@/agents/registry/buildAgentResumeUiConfig';
import { buildAgentSessionStorageUiConfig } from '@/agents/registry/buildAgentSessionStorageUiConfig';
import { buildAgentToolsUiConfig } from '@/agents/registry/buildAgentToolsUiConfig';
import { getAgentModelConfig, getAgentSessionModesKind } from '@happier-dev/agents';
import { projectAgyQuotaSnapshotForModel } from './projectQuotaSnapshotForModel';

export const AGY_CORE: AgentCoreConfig = {
    id: 'agy',
    displayNameKey: 'agentInput.agent.agy',
    subtitleKey: 'profiles.aiBackend.agySubtitleExperimental',
    permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
    availability: { experimental: true },
    connectedServices: buildAgentConnectedServicesUiConfig({ agentId: 'agy' }),
    projectQuotaSnapshotForModel: projectAgyQuotaSnapshotForModel,
    uiConnectedService: { serviceId: 'antigravity', label: 'Antigravity (AGY)', connectRoute: null },
    flavorAliases: ['agy'],
    cli: buildCatalogProviderCliUiConfig('agy'),
    permissions: {
        modeGroup: 'codexLike',
        promptProtocol: 'codexDecision',
    },
    sessionModes: {
        kind: getAgentSessionModesKind('agy'),
    },
    model: getAgentModelConfig('agy'),
    resume: buildAgentResumeUiConfig({
        agentId: 'agy',
        uiVendorResumeIdLabelKey: 'sessionInfo.agySessionId',
        uiVendorResumeIdCopiedKey: 'sessionInfo.agySessionIdCopied',
    }),
    localControl: buildAgentLocalControlUiConfig({ agentId: 'agy' }),
    toolRendering: {
        hideUnknownToolsByDefault: false,
    },
    tools: buildAgentToolsUiConfig({ agentId: 'agy' }),
    sessionStorage: buildAgentSessionStorageUiConfig({ agentId: 'agy' }),
    ui: {
        agentPickerIconName: 'rocket-outline',
        cliGlyphScale: 0.92,
        profileCompatibilityGlyphScale: 0.92,
    },
};
