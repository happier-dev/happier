import { randomBytes } from 'node:crypto';

import {
  PluginAgentContributionV2Schema,
  type BackendTargetRefV2,
} from '@happier-dev/protocol';

import type {
  AgentRuntimeDaemonSessionDescriptorV1,
} from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import { configuration } from '@/configuration';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { resolveContributedAgentRoutingId } from '@/plugins/projection/registry/agentRoutingIdentity';

import {
  createForegroundAgentRuntimeBootstrapAuthorization,
  createRunnerAgentSessionBootstrapAuthorization,
} from '../agentRuntime/sessionBridgeAuthorization';
import type { SpawnPluginRuntimeLease } from './spawnPluginRuntimeLease';
import { resolveEngineRuntimeContribution } from '@/agent/runtime/registry/engineRegistry/contributions';
import {
  snapshotActivatedPluginRuntimeAuthority,
} from '@/plugins/runtime/lifecycle/activation/runtimeAuthority';

export async function prepareForegroundAgentRuntimeBootstrapForLease(input: Readonly<{
  target: BackendTargetRefV2;
  lease: PluginRuntimeRegistryLease;
}>) {
  const descriptor =
    await resolveRunnerAgentSessionDescriptorForLease(input);
  if (!descriptor) return null;
  return await createForegroundAgentRuntimeBootstrapAuthorization({
    happyHomeDir: configuration.happyHomeDir,
    publicReleaseRing: configuration.publicReleaseRing,
    capability: randomBytes(32).toString('base64url'),
    descriptor,
  });
}

export async function prepareRunnerAgentSessionBootstrap(
  input: Readonly<{
    target: BackendTargetRefV2;
    pluginRuntimeLease: SpawnPluginRuntimeLease;
  }>,
) {
  const lease = await input.pluginRuntimeLease.acquire();
  return await prepareRunnerAgentSessionBootstrapForLease({
    target: input.target,
    lease,
  });
}

export async function prepareRunnerAgentSessionBootstrapForLease(
  input: Readonly<{
    target: BackendTargetRefV2;
    lease: PluginRuntimeRegistryLease;
  }>,
) {
  const descriptor =
    await resolveRunnerAgentSessionDescriptorForLease(input);
  if (!descriptor) return null;
  return await createRunnerAgentSessionBootstrapAuthorization({
    happyHomeDir: configuration.happyHomeDir,
    publicReleaseRing: configuration.publicReleaseRing,
    descriptor,
  });
}

async function resolveRunnerAgentSessionDescriptorForLease(
  input: Readonly<{
    target: BackendTargetRefV2;
    lease: PluginRuntimeRegistryLease;
  }>,
): Promise<AgentRuntimeDaemonSessionDescriptorV1 | null> {
  const lease = input.lease;
  const backend = resolveEngineRuntimeContribution(
    lease.registry.contributes,
    input.target.backendId,
  );
  if (!backend) {
    if (input.target.sourceKind === 'configured') return null;
    throw new Error(
      `Runner Agent backend '${input.target.backendId}' is unavailable in the admitted plugin registry`,
    );
  }
  await activateAgentRuntimeContributionOnDemand(lease.registry, backend.agentId);
  const registration = lease.registry.agentRuntimesByAgentId.get(backend.agentId);
  if (!registration?.hasPrimaryRuntime) {
    throw new Error(
      `Runner Agent runtime '${backend.pluginId ?? 'unknown'}/${backend.agentId}' was not published by activation`,
    );
  }
  const runtimeAuthority = snapshotActivatedPluginRuntimeAuthority(
    lease.registry,
    registration.pluginId,
  );
  if (!runtimeAuthority) {
    throw new Error(
      `Activated Agent runtime authority is unavailable for plugin '${registration.pluginId}'`,
    );
  }
  const agent = lease.registry.contributes.agentDefinitionsById.get(backend.agentId);
  if (
    !agent?.richDefinition
    || !agent.identity
    || agent.pluginId !== registration.pluginId
    || agent.identity.pluginId !== registration.pluginId
    || agent.richDefinition.provenance !== agent.provenance
  ) {
    throw new Error(
      `Activated Agent declaration is unavailable for plugin '${registration.pluginId}'`,
    );
  }
  const agentDefinition = PluginAgentContributionV2Schema.parse(
    {
      ...agent.richDefinition.definition,
      id: agent.identity.localId,
    },
  );
  return {
    v: 1,
    pluginId: registration.pluginId,
    pluginVersion: registration.pluginVersion,
    // The registry remains keyed by the canonical host routing id, and the
    // corridor's descriptor carries exactly that routing id. The manifest-local
    // id is reserved for contributor factory construction; the always-qualified
    // activation/service key travels only on the runner binding.
    agentId: resolveContributedAgentRoutingId({
      pluginId: registration.pluginId,
      localId: agent.identity.localId,
      provenance: agent.provenance,
    }),
    backendId: backend.id,
    generation: registration.generation,
    ...(registration.immutableGenerationId
      ? { immutableGenerationId: registration.immutableGenerationId }
      : {}),
    agentDeclaration: {
      provenance: agent.provenance,
      source: agent.source,
      definition: agentDefinition,
    },
    runtimeAuthority: {
      runtimeCapabilities: [...runtimeAuthority.runtimeCapabilities],
    },
  };
}
