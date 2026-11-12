import type { ExternalSessionsAgentId, ExternalSessionsSource } from '@happier-dev/protocol';

import { resolveHostedExternalSessionIdentityTag } from '@/api/session/external/linking/externalSessionIdentity';
import { runExternalSessionIdentityBackfill } from '@/api/session/external/linking/externalSessionIdentityBackfill';
import type { StoredCredentials } from '@/persistence';
import { createExternalSessionSourceKeyOwnerFromAgentProjection } from '@/plugins/projection/registry/externalSessionSources';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { logger } from '@/ui/logger';

/**
 * Daemon start: index this Machine's released external-session identities once
 * (see `runExternalSessionIdentityBackfill`). Source keys come from the current
 * Agent projection; a hosted Session's source is the configured source that
 * holds its native id, resolved by the current global External Sessions owner.
 */
export async function startDaemonExternalSessionIdentityBackfill(input: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  reloadController: PluginReloadController;
  signal: AbortSignal;
}>): Promise<void> {
  const resolveSourceKeyOwner = async (agentId: ExternalSessionsAgentId, source: ExternalSessionsSource) => {
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease({ controller: input.reloadController });
    try {
      return createExternalSessionSourceKeyOwnerFromAgentProjection(lease.registry.contributes, agentId, source);
    } finally {
      await lease.release();
    }
  };
  const router = input.reloadController.currentGlobalExternalSessions;
  const result = await runExternalSessionIdentityBackfill({
    credentials: input.credentials,
    machineId: input.machineId,
    signal: input.signal,
  }, {
    resolveSourceKeyOwner,
    resolveHostedIdentityTag: async ({ agentId, remoteSessionId, signal }) => {
      await router.activateConfiguredSources(agentId);
      const current = router.resolveCurrent();
      if (!current) return null;
      return await resolveHostedExternalSessionIdentityTag({
        machineId: input.machineId,
        agentId,
        remoteSessionId,
        resolveSourceIdentity: (request) => current.compositionPort.resolveSourceIdentity(request),
        resolveSourceKeyOwner,
        ...(signal ? { signal } : {}),
      });
    },
  });
  logger.debug('[DAEMON RUN] External-session identity backfill settled', result);
}
