import {
  ExecutionRunConnectedServicesCleanupReceiptV1Schema,
  ExecutionRunConnectedServicesLaunchV1Schema,
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
  executionRunConnectedServicesCleanupReceiptV1?: unknown;
}>;

/**
 * Re-attests one still-running current-writer run over the existing scoped
 * runner/daemon channel. The public marker remains cleanup-only: its receipt
 * can only join the runner-carried registration to the exact running
 * run/activation/Agent and never supplies bindings, paths, or authority itself.
 */
export async function reattestRunningExecutionRunConnectedServices(input: Readonly<{
  markers: readonly CandidateMarker[] | (() => Promise<readonly CandidateMarker[]>);
  runId: string;
  runnerPid: number;
  registration: unknown;
  proveRunnerLive: (marker: CandidateMarker) => boolean | Promise<boolean>;
  adopt: ExecutionRunConnectedServicesBridge['adoptLiveMaterialization'];
}>): Promise<boolean> {
  const parsedRegistration =
    ExecutionRunConnectedServicesLaunchV1Schema.safeParse(input.registration);
  if (!parsedRegistration.success) return false;
  const registration = parsedRegistration.data;
  if (
    !registration.activationId
    || registration.runKey !== input.runId
    || registration.materializationKey !== input.runId
  ) {
    return false;
  }
  const markers = typeof input.markers === 'function'
    ? await input.markers()
    : input.markers;
  const matches = markers.filter((marker) => marker.runId === input.runId);
  if (matches.length !== 1) return false;
  const marker = matches[0]!;
  if (
    marker.pid !== input.runnerPid
    || marker.happySessionId === null
    || marker.status !== 'running'
    || typeof marker.finishedAtMs === 'number'
  ) {
    return false;
  }
  const parsedReceipt =
    ExecutionRunConnectedServicesCleanupReceiptV1Schema.safeParse(
      marker.executionRunConnectedServicesCleanupReceiptV1,
    );
  if (
    !parsedReceipt.success
    || parsedReceipt.data.runKey !== registration.runKey
    || parsedReceipt.data.activationId !== registration.activationId
    || parsedReceipt.data.agentId !== registration.agentId
    || !(await input.proveRunnerLive(marker))
  ) {
    return false;
  }
  return await input.adopt({
    runId: input.runId,
    runnerPid: input.runnerPid,
    sessionId: marker.happySessionId,
    persistedLaunch: registration,
  });
}

/**
 * Rebuilds daemon-local run distribution and cleanup ownership only after runner liveness is
 * independently proven. Persisted marker data never grants authority to launch, resume, replay,
 * send, or drain work.
 */
export async function rehydrateLiveExecutionRunTargets(input: Readonly<{
  markers: readonly CandidateMarker[] | (() => Promise<readonly CandidateMarker[]>);
  proveRunnerLive: (marker: CandidateMarker) => boolean | Promise<boolean>;
  adopt: ExecutionRunConnectedServicesBridge['adoptLiveMaterialization'];
  cleanupTerminal?: ExecutionRunConnectedServicesBridge['cleanupTerminalMaterialization'];
  clearTerminalCleanupReceipt?: (runId: string) => Promise<void>;
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
    if (!isRunning) {
      if (marker.executionRunConnectedServicesCleanupReceiptV1 && input.cleanupTerminal) {
        const cleaned = await input.cleanupTerminal({
          runId: marker.runId,
          runnerPid: marker.pid,
          sessionId: marker.happySessionId,
          receipt: marker.executionRunConnectedServicesCleanupReceiptV1,
        });
        if (cleaned) {
          await input.clearTerminalCleanupReceipt?.(marker.runId);
        }
      }
      inactiveRunIds.push(marker.runId);
      continue;
    }
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
    if (!isExact || !(await input.proveRunnerLive(marker))) {
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
