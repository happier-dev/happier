import type { AgentCoreConfig, MachineLoginKey } from '@/agents/registry/registryCore';
import {
    AGENT_IDS,
    DEFAULT_AGENT_ID,
    getAgentCore as getExpoAgentCore,
    isAgentId,
    resolveAgentIdFromCliDetectKey,
    resolveAgentIdFromConnectedServiceId,
    resolveAgentIdFromFlavor,
    type AgentId,
} from '@/agents/registry/registryCore';

import type { AgentUiConfig } from '@/agents/registry/registryUi';
type RegistryUiModule = typeof import('@/agents/registry/registryUi');
type AgentIconTintTheme = Parameters<RegistryUiModule['getAgentIconTintColor']>[1];

import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import {
    AGENTS_UI_BEHAVIOR,
    buildResumeCapabilityOptionsFromUiState,
    buildNewSessionOptionsFromUiState,
    canSelectAgentWithoutDetectedCli,
    getNewSessionAgentInputExtraActionChips,
    buildSpawnEnvironmentVariablesFromUiState,
    buildResumeSessionExtrasFromUiState,
    buildSpawnSessionExtrasFromUiState,
    buildWakeResumeExtras,
    getAgentResumeExperimentsFromSettings,
    getNewSessionPreflightIssues,
    getNewSessionRelevantInstallableDepKeys,
} from '@/agents/registry/registryUiBehavior';

export { AGENT_IDS, DEFAULT_AGENT_ID };
export type { AgentId, MachineLoginKey };

export type AgentCatalogEntry = Readonly<{
    id: AgentId;
    core: AgentCoreConfig;
    ui: AgentUiConfig;
    behavior: AgentUiBehavior;
}>;

function registryUi() {
    // Lazily load UI assets so Node-side tests can import `@/agents/catalog`
    // without requiring image files.
    return require('@/agents/registry/registryUi') as typeof import('@/agents/registry/registryUi');
}

export function getAgentCore(id: AgentId): AgentCoreConfig {
    return getExpoAgentCore(id);
}

export function writeAgentVendorResumeIdToMetadata<Metadata extends Record<string, unknown>>(
    metadata: Metadata,
    agentId: AgentId,
    vendorResumeId: string,
): Metadata {
    const vendorResumeIdField = getAgentCore(agentId).resume.vendorResumeIdField;
    if (!vendorResumeIdField) return metadata;
    return {
        ...metadata,
        [vendorResumeIdField]: vendorResumeId,
    };
}

export function getAgentUi(id: AgentId): AgentUiConfig {
    return registryUi().AGENTS_UI[id];
}

export function getAgentIconSource(agentId: AgentId): ReturnType<RegistryUiModule['getAgentIconSource']> {
    return registryUi().getAgentIconSource(agentId);
}

export function getAgentIconSvgXml(
    agentId: AgentId,
    theme: Parameters<RegistryUiModule['getAgentIconSvgXml']>[1],
): ReturnType<RegistryUiModule['getAgentIconSvgXml']> {
    return registryUi().getAgentIconSvgXml(agentId, theme);
}

export function getAgentIconTintColor(
    agentId: AgentId,
    theme: AgentIconTintTheme,
): ReturnType<RegistryUiModule['getAgentIconTintColor']> {
    return registryUi().getAgentIconTintColor(agentId, theme);
}

export function getAgentAvatarOverlaySizes(
    agentId: AgentId,
    size: number,
): ReturnType<RegistryUiModule['getAgentAvatarOverlaySizes']> {
    return registryUi().getAgentAvatarOverlaySizes(agentId, size);
}

export function getAgentPickerIconScale(agentId: AgentId): ReturnType<RegistryUiModule['getAgentPickerIconScale']> {
    return registryUi().getAgentPickerIconScale(agentId);
}

export function getAgentCliGlyph(agentId: AgentId): ReturnType<RegistryUiModule['getAgentCliGlyph']> {
    return registryUi().getAgentCliGlyph(agentId);
}

export function getAgentBehavior(id: AgentId): AgentUiBehavior {
    return AGENTS_UI_BEHAVIOR[id];
}

export function getAgent(id: AgentId): AgentCatalogEntry {
    return {
        id,
        core: getAgentCore(id),
        ui: getAgentUi(id),
        behavior: getAgentBehavior(id),
    };
}

export {
    isAgentId,
    resolveAgentIdFromFlavor,
    resolveAgentIdFromCliDetectKey,
    resolveAgentIdFromConnectedServiceId,
    getAgentResumeExperimentsFromSettings,
    buildResumeCapabilityOptionsFromUiState,
    getNewSessionPreflightIssues,
    buildNewSessionOptionsFromUiState,
    canSelectAgentWithoutDetectedCli,
    getNewSessionAgentInputExtraActionChips,
    getNewSessionRelevantInstallableDepKeys,
    buildSpawnEnvironmentVariablesFromUiState,
    buildSpawnSessionExtrasFromUiState,
    buildResumeSessionExtrasFromUiState,
    buildWakeResumeExtras,
};
