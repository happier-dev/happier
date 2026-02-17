import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { readBackendChildSessionId } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import { writeExecutionRunMarker } from '@/daemon/executionRunRegistry';

export function enqueueExecutionRunMarkerWrite(args: Readonly<{
  markerWriteChains: Map<string, Promise<void>>;
  runId: string;
  write: () => Promise<void>;
}>): Promise<void> {
  const prev = args.markerWriteChains.get(args.runId) ?? Promise.resolve();
  const next = prev.then(args.write, args.write);
  args.markerWriteChains.set(
    args.runId,
    next.finally(() => {
      if (args.markerWriteChains.get(args.runId) === next) {
        args.markerWriteChains.delete(args.runId);
      }
    }),
  );
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
    backendId: run.backendId,
    ...(run.display ? { display: run.display } : {}),
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
      const vendorSessionId = readBackendChildSessionId(args.controllers.get(args.runId) ?? null);
      if (typeof vendorSessionId === 'string' && vendorSessionId.trim().length > 0) {
        return { kind: 'vendor_session.v1', backendId: run.backendId, vendorSessionId };
      }
      return run.resumeHandle ?? null;
    })(),
  } as const;
  await args.enqueueMarkerWrite(args.runId, () => writeExecutionRunMarker(markerPayload)).catch(() => {});
}

