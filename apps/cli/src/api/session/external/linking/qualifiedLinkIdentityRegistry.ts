import type { ExternalSessionsAgentId } from '@happier-dev/protocol';

import type { ResolvedAgentContribution } from '@/plugins/projection/registry/types';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

import type { CurrentExternalSessionAgentIdentity } from './qualifiedLinkIdentity';

export function readCurrentExternalSessionAgentIdentity(
  agent: ResolvedAgentContribution | undefined,
): CurrentExternalSessionAgentIdentity | null {
  if (!agent?.identity) return null;
  return {
    identity: agent.identity,
    sourceKinds: agent.richDefinition?.definition.surfaces?.externalSession?.sources.map(
      (source) => source.sourceKind,
    ) ?? [],
  };
}

/** Reads the installed manifest catalog only. Runtime generation remains invocation-owned. */
export async function resolveCurrentExternalSessionAgentIdentity(
  agentId: ExternalSessionsAgentId,
): Promise<CurrentExternalSessionAgentIdentity | null> {
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  try {
    return readCurrentExternalSessionAgentIdentity(
      lease.registry.contributes.agentDefinitionsById.get(agentId),
    );
  } finally {
    await lease.release();
  }
}
