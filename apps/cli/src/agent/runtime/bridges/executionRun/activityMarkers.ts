import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from './executionRunTypes';
import { retainExecutionRunState, writeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildExecutionRunConnectedServicesCleanupReceipt } from './connectedServicesCleanupReceipt';
import { projectExecutionRunPublicState } from './publicState';

export function enqueueExecutionRunMarkerWrite(args: Readonly<{
  markerWriteChains: Map<string, Promise<void>>;
  runId: string;
  write: () => Promise<void>;
}>): Promise<void> {
  const prev = args.markerWriteChains.get(args.runId) ?? Promise.resolve();
  const next = prev.then(args.write, args.write);
  // Ensure the stored chain never rejects. `next` may be awaited by callers (and they may
  // attach their own error handling), but the internal sequencing chain must not trigger
  // unhandled promise rejections when best-effort writes fail (e.g. tmp dir cleanup races).
  const chain = next
    .catch(() => {})
    .finally(() => {
      if (args.markerWriteChains.get(args.runId) === chain) {
        args.markerWriteChains.delete(args.runId);
      }
    });
  args.markerWriteChains.set(args.runId, chain);
  return next;
}

export async function writeExecutionRunActivityMarker(args: Readonly<{
  runId: string;
  nowMs: number;
  opts?: Readonly<{ force?: boolean; resumed?: boolean }>;
  runs: Map<string, ExecutionRunState>;
  retainedState?: ExecutionRunState;
  controllers: Map<string, ExecutionRunController>;
  enqueueMarkerWrite: (runId: string, write: () => Promise<void>) => Promise<void>;
}>): Promise<void> {
  const run = args.runs.get(args.runId);
  const ctrl = args.controllers.get(args.runId);
  if (!run || (!ctrl && args.opts?.force !== true)) return;
  if (run.status !== 'running') return;

  // Avoid noisy disk writes when models stream deltas or long-lived chats are active.
  // This is best-effort telemetry for machine-wide visibility only.
  const throttleMs = 1_000;
  if (ctrl && args.opts?.force !== true && args.nowMs - ctrl.lastMarkerWriteAtMs < throttleMs) return;
  if (ctrl) ctrl.lastMarkerWriteAtMs = args.nowMs;

  const cleanupReceipt = buildExecutionRunConnectedServicesCleanupReceipt(
    run.launch?.connectedServicesRegistration,
  );
  const { requestedConfiguration, resolvedSelection } = projectExecutionRunPublicState(run);
  const markerPayload = {
    pid: process.pid,
    ...(run.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: run.requesterWorkAttributionV1 } : {}),
    happySessionId: run.sessionId,
    runId: run.runId,
    callId: run.callId,
    sidechainId: run.sidechainId,
    intent: run.intent,
    backendTarget: readBackendTargetRefV2(run.backendTarget),
    ...(run.launch?.launchOrigin ? { launchOrigin: run.launch.launchOrigin } : {}),
    ...(requestedConfiguration ? { requestedConfiguration } : {}),
    ...(resolvedSelection ? { resolvedSelection } : {}),
    permissionMode: run.permissionMode,
    approvalProfileId: run.approvalProfileId ?? null,
    retentionPolicy: run.retentionPolicy,
    runClass: run.runClass,
    ioMode: run.ioMode,
    status: run.status,
    startedAtMs: run.startedAtMs,
    updatedAtMs: args.nowMs,
    lastActivityAtMs: args.nowMs,
    ...(run.error?.code ? { errorCode: run.error.code } : {}),
    ...(cleanupReceipt
      ? { executionRunConnectedServicesCleanupReceiptV1: cleanupReceipt }
      : {}),
  } as const;
  const isCurrentOccurrence = (): boolean => {
    const current = args.runs.get(args.runId);
    return current?.status === 'running'
      && current.launch?.connectedServicesRegistration === run.launch?.connectedServicesRegistration
      && (ctrl ? args.controllers.get(args.runId) === ctrl && !ctrl.cancelled : args.opts?.resumed !== true);
  };
  await args.enqueueMarkerWrite(args.runId, async () => {
    if (!isCurrentOccurrence()) return;
    await retainExecutionRunState(args.retainedState ?? run);
    if (!isCurrentOccurrence()) return;
    await writeExecutionRunMarker(markerPayload, { allowTerminalToRunning: args.opts?.resumed === true }).catch(() => {});
  });
}
