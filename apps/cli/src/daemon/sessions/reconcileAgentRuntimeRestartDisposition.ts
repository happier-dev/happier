import { resolveEngineRuntimeContribution } from '@/agent/runtime/registry/engineRegistry/contributions';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';

import type { TrackedSession } from '../types';
import { resolveTrackedSessionCatalogAgentId } from './resolveTrackedSessionCatalogAgentId';
import type { StopSessionResult } from './stopSessionContract';

type AcquireRegistryLease = typeof acquireAuthoritativePluginRuntimeRegistryLease;

/**
 * Resolves restart survivors only after the daemon has published its current
 * authoritative plugin generation. A native Agent session's runtime handle is
 * process-local, so exact process identity can preserve retirement custody but
 * cannot make the session usable in the successor daemon.
 */
export async function reconcileAgentRuntimeRestartDisposition(params: Readonly<{
  trackedSessions: Iterable<TrackedSession>;
  acquireRegistryLease?: AcquireRegistryLease;
  retireSession?: (sessionId: string) => Promise<StopSessionResult>;
  isShuttingDown?: () => boolean;
}>): Promise<readonly Readonly<{
  sessionId: string;
  result: StopSessionResult;
}>[]> {
  if (params.isShuttingDown?.() === true) return [];

  const survivors = Array.from(params.trackedSessions)
    .filter((tracked) => tracked.reattachedFromDiskMarker === true);
  if (survivors.length === 0) return [];

  const restartUnavailableSessionIds = new Set<string>();
  const rememberRestartUnavailableSession = (tracked: TrackedSession): void => {
    tracked.agentRuntimeRestartDisposition =
      'bridge_authority_unavailable';
    const sessionId = tracked.happySessionId?.trim() ?? '';
    if (sessionId) restartUnavailableSessionIds.add(sessionId);
  };
  const unresolved = survivors.filter(
    (tracked) =>
      tracked.agentRuntimeRestartDisposition
        !== 'bridge_authority_unavailable',
  );
  for (const tracked of survivors) {
    if (
      tracked.agentRuntimeRestartDisposition
        === 'bridge_authority_unavailable'
    ) {
      rememberRestartUnavailableSession(tracked);
    }
  }

  if (unresolved.length > 0) {
    const lease = await (
      params.acquireRegistryLease ?? acquireAuthoritativePluginRuntimeRegistryLease
    )();
    try {
      if (params.isShuttingDown?.() === true) return [];
      for (const tracked of unresolved) {
        if (resolveTrackedSessionCatalogAgentId(tracked)) {
          rememberRestartUnavailableSession(tracked);
          continue;
        }
        if (tracked.spawnOptions?.backendTarget?.sourceKind === 'configured') {
          continue;
        }
        const backendId = tracked.spawnOptions?.backendTarget?.backendId?.trim() ?? '';
        if (!backendId) continue;
        const backend = resolveEngineRuntimeContribution(
          lease.registry.contributes,
          backendId,
        );
        if (!backend) continue;
        rememberRestartUnavailableSession(tracked);
      }
    } finally {
      await lease.release();
    }
  }

  if (!params.retireSession) return [];

  const retirementResults: Array<Readonly<{
    sessionId: string;
    result: StopSessionResult;
  }>> = [];
  for (const sessionId of restartUnavailableSessionIds) {
    if (params.isShuttingDown?.() === true) break;
    retirementResults.push({
      sessionId,
      result: await params.retireSession(sessionId),
    });
  }
  return retirementResults;
}
