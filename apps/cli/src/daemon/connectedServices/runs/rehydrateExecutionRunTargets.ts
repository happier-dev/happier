import {
  isPersistedExecutionRunConnectedServicesLaunchIdentityExact,
  normalizePersistedExecutionRunConnectedServicesLaunchV1,
} from '@happier-dev/protocol';

import { isCatalogAgentId } from '@/agent/catalog/resolution';

import type { ExecutionRunConnectedServicesBridge } from './executionRunMaterialization';

type CandidateMarker = Readonly<{
  runId: string;
  happySessionId: string | null;
  pid: number;
  status: unknown;
  finishedAtMs?: unknown;
  executionRunConnectedServicesLaunchV1?: unknown;
}>;

/**
 * Rebuilds daemon-local run distribution and cleanup ownership only after runner liveness is
 * independently proven. Persisted marker data never grants authority to launch, resume, replay,
 * send, or drain work.
 */
export async function rehydrateLiveExecutionRunTargets(input: Readonly<{
  markers: readonly CandidateMarker[] | (() => Promise<readonly CandidateMarker[]>);
  proveRunnerLive: (marker: CandidateMarker) => boolean | Promise<boolean>;
  adopt: ExecutionRunConnectedServicesBridge['adoptLiveMaterialization'];
}>): Promise<Readonly<{ registeredRunIds: string[]; inactiveRunIds: string[] }>> {
  const markers = typeof input.markers === 'function' ? await input.markers() : input.markers;
  const candidates = markers.map((marker) => ({
    marker,
    normalized: normalizePersistedExecutionRunConnectedServicesLaunchV1(
      marker.executionRunConnectedServicesLaunchV1,
    ),
  }));
  const runKeyCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.normalized) continue;
    const runKey = candidate.normalized.registration.runKey;
    runKeyCounts.set(runKey, (runKeyCounts.get(runKey) ?? 0) + 1);
  }

  const registeredRunIds: string[] = [];
  const inactiveRunIds: string[] = [];
  for (const candidate of candidates) {
    const { marker, normalized } = candidate;
    // A detached run has no Session runner to prove or re-adopt. Its marker is
    // observability only; daemon loss does not manufacture a restart owner.
    if (marker.happySessionId === null) {
      inactiveRunIds.push(marker.runId);
      continue;
    }
    const isRunning = marker.status === 'running' && typeof marker.finishedAtMs !== 'number';
    const registration = normalized?.registration;
    const isExact = Boolean(
      registration
      && normalized
      && isPersistedExecutionRunConnectedServicesLaunchIdentityExact({
        markerRunId: marker.runId,
        normalized,
      })
      && registration.materializationKey === registration.runKey
      && isCatalogAgentId(registration.agentId)
      && runKeyCounts.get(registration.runKey) === 1,
    );
    if (!isRunning || !isExact || !(await input.proveRunnerLive(marker))) {
      inactiveRunIds.push(marker.runId);
      continue;
    }
    if (
      !registration
      || !normalized
      || !(await input.adopt({
        runId: marker.runId,
        runnerPid: marker.pid,
        sessionId: marker.happySessionId,
        persistedLaunch: marker.executionRunConnectedServicesLaunchV1,
      }))
    ) {
      inactiveRunIds.push(marker.runId);
      continue;
    }
    registeredRunIds.push(marker.runId);
  }
  return { registeredRunIds, inactiveRunIds };
}
