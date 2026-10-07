import type { AgentCliSessionCommandPluginSettingsV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { AGENTS } from '@/agent/catalog/registry';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { resolveConfiguredAcpProbeCacheVariant } from './configuredAcpProbeCacheVariant';
import type { PreflightSessionControlsProbeKind } from './preflightSessionControlsProbeAdapterTypes';

export async function resolveAgentProbeVariant(params: Readonly<{
  agentId: CatalogAgentLookupId;
  catalogEntry?: AgentCatalogEntry | null;
  runtimeCacheKey?: string;
  probeKind?: PreflightSessionControlsProbeKind;
  backendTarget?: BackendTargetRefV1;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  runtimeKindOverride?: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  pluginSettings?: AgentCliSessionCommandPluginSettingsV1;
  env?: NodeJS.ProcessEnv;
}>): Promise<string> {
  const configuredAcpVariant = await resolveConfiguredAcpProbeCacheVariant({
    agentId: params.agentId,
    backendTarget: params.backendTarget,
    accountSettings: params.accountSettings,
  });

  const entry = params.catalogEntry === undefined ? AGENTS[params.agentId] : params.catalogEntry;
  const probeKind = params.probeKind ?? 'models';
  const resolveEntryVariant = entry?.resolveSessionControlsProbeVariant ?? entry?.resolveModelsProbeVariant;
  const entryVariant = configuredAcpVariant ?? resolveEntryVariant?.({
    backendTarget: params.backendTarget,
    runtimeDescriptorV1: params.runtimeDescriptorV1,
    runtimeKindOverride: params.runtimeKindOverride,
    probeKind,
    accountSettings: params.accountSettings ?? null,
    pluginSettings: params.pluginSettings,
    env: params.env,
  }) ?? null;
  const variant = configuredAcpVariant ?? entryVariant ?? `${params.agentId}:default`;
  return params.runtimeCacheKey || params.runtimeDescriptorV1 || params.runtimeKindOverride !== undefined || params.pluginSettings !== undefined
    ? JSON.stringify([params.runtimeCacheKey ?? null, variant, params.runtimeDescriptorV1 ?? null, params.runtimeKindOverride ?? null, params.pluginSettings ?? null]) : variant;
}
