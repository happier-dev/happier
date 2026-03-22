import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { readBackendResumableChildSessionId } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import { areExecutionRunBackendTargetsEqual } from '@/agent/executionRuns/runtime/backendTargets';
import { writeExecutionRunMarker } from '@/daemon/executionRunRegistry';

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
  opts?: Readonly<{ force?: boolean }>;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  enqueueMarkerWrite: (runId: string, write: () => Promise<void>) => Promise<void>;
}>): Promise<void> {
  const run = args.runs.get(args.runId);
  const ctrl = args.controllers.get(args.runId);
  if (!run || !ctrl) return;
  if (run.status !== 'running') return;

  // Avoid noisy disk writes when models stream deltas or long-lived chats are active.
  // This is best-effort telemetry for machine-wide visibility only.
  const throttleMs = 1_000;
  if (args.opts?.force !== true && args.nowMs - ctrl.lastMarkerWriteAtMs < throttleMs) return;
  ctrl.lastMarkerWriteAtMs = args.nowMs;

  const markerPayload = {
    pid: process.pid,
    happySessionId: run.sessionId,
    runId: run.runId,
    callId: run.callId,
    sidechainId: run.sidechainId,
    intent: run.intent,
    backendTarget: run.backendTarget,
    ...(run.display ? { display: run.display } : {}),
    permissionMode: run.permissionMode,
    runClass: run.runClass,
    ioMode: run.ioMode,
    retentionPolicy: run.retentionPolicy,
    status: run.status,
    startedAtMs: run.startedAtMs,
    updatedAtMs: args.nowMs,
    lastActivityAtMs: args.nowMs,
    ...(typeof run.summary === 'string' && run.summary.trim().length > 0 ? { summary: run.summary } : {}),
    ...(run.error?.code ? { errorCode: run.error.code } : {}),
    resumeHandle: (() => {
      const vendorSessionId = readBackendResumableChildSessionId(args.controllers.get(args.runId) ?? null);
      if (typeof vendorSessionId === 'string' && vendorSessionId.trim().length > 0) {
        return { kind: 'vendor_session.v1', backendTarget: run.backendTarget, vendorSessionId };
      }
      return run.resumeHandle
        && run.resumeHandle.kind === 'vendor_session.v1'
        && areExecutionRunBackendTargetsEqual(run.resumeHandle.backendTarget, run.backendTarget)
        ? run.resumeHandle
        : null;
    })(),
  } as const;
  await args.enqueueMarkerWrite(args.runId, () => writeExecutionRunMarker(markerPayload)).catch(() => {});
}
