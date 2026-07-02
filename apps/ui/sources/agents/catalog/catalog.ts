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
import { applyProviderSessionIdSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
type RegistryUiModule = typeof import('@/agents/registry/registryUi');
type AgentIconTintTheme = Parameters<RegistryUiModule['getAgentIconTintColor']>[1];
import * as RegistryUi from '@/agents/registry/registryUi';

import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import {
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
    resolveAgentUiBehavior,
} from '@/agents/registry/registryUiBehavior';

export { AGENT_IDS, DEFAULT_AGENT_ID };
export type { AgentId, MachineLoginKey };

export type AgentCatalogEntry = Readonly<{
    id: AgentId;
    core: AgentCoreConfig;
    ui: AgentUiConfig;
    behavior: AgentUiBehavior;
}>;

function registryUi(): typeof RegistryUi {
    return RegistryUi;
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
    return applyProviderSessionIdSessionMetadata(metadata, {
        metadataKey: vendorResumeIdField,
        value: vendorResumeId,
    });
}

export function getAgentUi(id: AgentId): AgentUiConfig {
    return registryUi().CANONICAL_AGENTS_UI[id];
}

export function getAgentIconSource(agentId: string): ReturnType<RegistryUiModule['getAgentIconSource']> {
    return registryUi().getAgentIconSource(agentId);
}

export function getAgentIconSvgXml(
    agentId: string,
    theme: Parameters<RegistryUiModule['getAgentIconSvgXml']>[1],
): ReturnType<RegistryUiModule['getAgentIconSvgXml']> {
    return registryUi().getAgentIconSvgXml(agentId, theme);
}

export function getAgentIconTintColor(
    agentId: string,
    theme: AgentIconTintTheme,
): ReturnType<RegistryUiModule['getAgentIconTintColor']> {
    return registryUi().getAgentIconTintColor(agentId, theme);
}

export function getAgentAvatarOverlaySizes(
    agentId: string,
    size: number,
): ReturnType<RegistryUiModule['getAgentAvatarOverlaySizes']> {
    return registryUi().getAgentAvatarOverlaySizes(agentId, size);
}

export function getAgentPickerIconScale(agentId: string): ReturnType<RegistryUiModule['getAgentPickerIconScale']> {
    return registryUi().getAgentPickerIconScale(agentId);
}

export function getAgentCliGlyph(agentId: string): ReturnType<RegistryUiModule['getAgentCliGlyph']> {
    return registryUi().getAgentCliGlyph(agentId);
}

export function getAgentBehavior(id: AgentId): AgentUiBehavior {
    return resolveAgentUiBehavior(id);
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
