import type {
  ExternalSessionsAgentId,
  ExternalSessionsSource,
} from '@happier-dev/protocol';

import {
  createExternalSessionSourceKeyOwnerFromAgentProjection,
  type ExternalSessionSourceKeyOwner,
} from '@/plugins/projection/registry/externalSessionSources';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

export async function resolveExternalSessionSourceKeyOwner(
  agentId: ExternalSessionsAgentId,
  source: ExternalSessionsSource,
): Promise<ExternalSessionSourceKeyOwner | null> {
  const runtimeRegistryLease =
    await acquireAuthoritativePluginRuntimeRegistryLease();
  try {
    return createExternalSessionSourceKeyOwnerFromAgentProjection(
      runtimeRegistryLease.registry.contributes,
      agentId,
      source,
    );
  } finally {
    await runtimeRegistryLease.release();
  }
}
