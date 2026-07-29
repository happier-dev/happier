import { randomBytes } from 'node:crypto';

import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { configuration } from '@/configuration';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';

import { createAgentRuntimeSessionBridgeAuthorization } from '../agentRuntime/sessionBridgeAuthorization';
import type { SpawnPluginRuntimeLease } from './spawnPluginRuntimeLease';
import { resolveEngineRuntimeContribution } from '@/agent/runtime/registry/engineRegistry/contributions';
import {
  snapshotActivatedPluginRuntimeAuthority,
} from '@/plugins/runtime/lifecycle/activation/runtimeAuthority';
import {
  snapshotAgentSessionRealtimeVoiceProviders,
} from '@/agent/runtime/session/realtime/resolveAgentSessionRealtimeVoiceAuthority';

export async function prepareAgentRuntimeSessionBridge(input: Readonly<{
  target: BackendTargetRefV2;
  pluginRuntimeLease: SpawnPluginRuntimeLease;
}>) {
  const lease = await input.pluginRuntimeLease.acquire();
  return await prepareAgentRuntimeSessionBridgeForLease({
    target: input.target,
    lease,
  });
}

export async function prepareAgentRuntimeSessionBridgeForLease(input: Readonly<{
  target: BackendTargetRefV2;
  lease: PluginRuntimeRegistryLease;
}>) {
  const lease = input.lease;
  const backend = resolveEngineRuntimeContribution(
    lease.registry.contributes,
    input.target.backendId,
  );
  if (!backend) return null;
  await activateAgentRuntimeContributionOnDemand(lease.registry, backend.agentId);
  const registration = lease.registry.agentRuntimesByAgentId.get(backend.agentId);
  if (!registration?.hasPrimaryRuntime) return null;
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
  const sessionCapabilities = readAgentSessionCapabilities(agent?.richDefinition?.definition);
  const realtimeProviders = snapshotAgentSessionRealtimeVoiceProviders({
    runtimeRegistry: lease.registry,
    policyAgentRef: {
      pluginId: registration.pluginId,
      localId: registration.agentId,
    },
  });
  return await createAgentRuntimeSessionBridgeAuthorization({
    happyHomeDir: configuration.happyHomeDir,
    publicReleaseRing: configuration.publicReleaseRing,
    token: randomBytes(32).toString('base64url'),
    descriptor: {
      v: 1,
      pluginId: registration.pluginId,
      pluginVersion: registration.pluginVersion,
      agentId: registration.agentId,
      backendId: backend.id,
      generation: registration.generation,
      ...(registration.immutableGenerationId
        ? { immutableGenerationId: registration.immutableGenerationId }
        : {}),
      runtimeAuthority: {
        permissions: [...runtimeAuthority.permissions],
        runtimeCapabilities: [...runtimeAuthority.runtimeCapabilities],
      },
      runtimeSurfaces: {
        terminal:
          agent?.richDefinition?.definition.capabilities.surfaces
            ?.includes('terminal') === true,
        ...(realtimeProviders.length > 0
          ? {
              realtimeConversation: {
                providers: realtimeProviders.map(({ provider, lifecycle }) => ({
                  identity: provider.identity,
                  manifestDigest: provider.manifestDigest,
                  generation: lifecycle.generation,
                  declaration: provider.definition,
                })),
              },
            }
          : {}),
      },
      factoryControls: {
        continuation: sessionCapabilities?.continuationVerification !== undefined,
        goals: sessionCapabilities?.goals !== undefined,
        catalog: sessionCapabilities?.catalog !== undefined,
        usageLimitRecovery: sessionCapabilities?.usageLimitRecovery !== undefined,
      },
    },
  });
}
