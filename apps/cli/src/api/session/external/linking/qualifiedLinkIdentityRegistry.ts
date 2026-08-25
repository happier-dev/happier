import type {
  ExternalSessionsAgentId,
  PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import {
  indexAgentRoutingIdsByContributionIdentity,
  readAgentRoutingIdForContributionIdentity,
} from '@/plugins/projection/registry/agentRoutingIdentity';
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

/**
 * Resolves the host routing id that currently addresses one durable
 * `{pluginId, localId}` Agent identity — the exact inverse of
 * `resolveCurrentExternalSessionAgentIdentity`.
 *
 * Durable External Sessions records persist the identity, while every host
 * lookup — execution surfaces, runtime leases, source-key owners, retired-link
 * tombstones — is keyed by the routing id the registry assigned. Only the
 * registry relates the two: an installed Agent is routed by its qualified key
 * while a bundled one keeps its unqualified released id, so comparing a
 * routing id against a bare `localId` silently only ever matches bundled
 * Agents. An identity the current catalog no longer contributes stays
 * unresolved rather than manufacturing a routing id.
 */
export async function resolveCurrentExternalSessionAgentRoutingId(
  identity: PluginContributionIdentityV1,
): Promise<ExternalSessionsAgentId | null> {
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  try {
    return readAgentRoutingIdForContributionIdentity(
      indexAgentRoutingIdsByContributionIdentity([
        ...lease.registry.contributes.agentDefinitionsById.values(),
      ]),
      identity,
    );
  } finally {
    await lease.release();
  }
}
