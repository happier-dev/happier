import { AGENTS } from '@/backends/catalog';
import type { CatalogAgentLookupId } from '@/backends/types';
import { configuration } from '@/configuration';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { resolveConfiguredAcpProbeCacheVariant } from './configuredAcpProbeCacheVariant';
import type { PreflightSessionControlsProbeKind } from './preflightSessionControlsProbeAdapterTypes';

export async function resolveAgentProbeVariant(params: Readonly<{
  agentId: CatalogAgentLookupId;
  probeKind?: PreflightSessionControlsProbeKind;
  backendTarget?: BackendTargetRefV1;
  accountSettings?: Readonly<Record<string, unknown>> | null;
}>): Promise<string> {
  const configuredAcpVariant = await resolveConfiguredAcpProbeCacheVariant({
    agentId: params.agentId,
    backendTarget: params.backendTarget,
    accountSettings: params.accountSettings,
    happyHomeDir: configuration.happyHomeDir,
  });
  if (configuredAcpVariant) return configuredAcpVariant;

  const entry = AGENTS[params.agentId];
  const probeKind = params.probeKind ?? 'models';
  const resolveEntryVariant = entry?.resolveSessionControlsProbeVariant ?? entry?.resolveModelsProbeVariant;
  const entryVariant = resolveEntryVariant?.({
    backendTarget: params.backendTarget,
    probeKind,
    accountSettings: params.accountSettings ?? null,
  }) ?? null;
  return entryVariant ?? `${params.agentId}:default`;
}
