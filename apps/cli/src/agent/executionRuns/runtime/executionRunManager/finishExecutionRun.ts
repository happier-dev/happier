import { randomUUID } from 'node:crypto';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { readBackendChildSessionId } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { writeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import type { ExecutionRunResumeHandle } from '@happier-dev/protocol';

type EnqueueMarkerWrite = (runId: string, write: () => Promise<void>) => Promise<void>;

type SendAcp = (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;

type FinishRunNext = Omit<
  ExecutionRunState,
  | 'runId'
  | 'callId'
  | 'sidechainId'
  | 'sessionId'
  | 'depth'
  | 'intent'
  | 'backendId'
  | 'instructions'
  | 'permissionMode'
  | 'retentionPolicy'
  | 'runClass'
  | 'ioMode'
  | 'startedAtMs'
  | 'resumeHandle'
> & {
  status: ExecutionRunState['status'];
  finishedAtMs: number;
};

export function finishExecutionRun(args: Readonly<{
  runId: string;
  next: FinishRunNext;
  toolResult: { output: any; isError?: boolean; meta?: Record<string, unknown> };
  structuredMeta?: ExecutionRunStructuredMeta;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  parentProvider: ACPProvider;
  sendAcp: SendAcp;
  enqueueMarkerWrite: EnqueueMarkerWrite;
  terminalMarkerWritePromises: Map<string, Promise<void>>;
}>): void {
  const existing = args.runs.get(args.runId);
  if (!existing) return;
  if (existing.status !== 'running') return;

  const resumeHandle: ExecutionRunResumeHandle | null = (() => {
    if (existing.retentionPolicy !== 'resumable') return null;
    const vendorSessionId = readBackendChildSessionId(args.controllers.get(args.runId) ?? null);
    if (typeof vendorSessionId === 'string' && vendorSessionId.trim().length > 0) {
      return { kind: 'vendor_session.v1', backendId: existing.backendId, vendorSessionId };
    }
    return existing.resumeHandle ?? null;
  })();

  const updated: ExecutionRunState = {
    ...existing,
    status: args.next.status,
    summary: args.next.summary ?? existing.summary,
    finishedAtMs: args.next.finishedAtMs,
    ...(args.next.error ? { error: args.next.error } : {}),
    ...(args.structuredMeta ? { structuredMeta: args.structuredMeta } : {}),
    latestToolResult: args.toolResult.output,
    ...(existing.retentionPolicy === 'resumable' ? { resumeHandle } : {}),
  };
  args.runs.set(args.runId, updated);
  if (updated.status !== 'running') {
    args.budgetRegistry?.releaseExecutionRun(args.runId);
  }

  // Best-effort: update daemon-visible marker for machine-wide run visibility.
  const markerPayload = {
    pid: process.pid,
    happySessionId: existing.sessionId,
    runId: updated.runId,
    callId: updated.callId,
    sidechainId: updated.sidechainId,
    intent: updated.intent,
    backendId: updated.backendId,
    ...(updated.display ? { display: updated.display } : {}),
    runClass: updated.runClass,
    ioMode: updated.ioMode,
    retentionPolicy: updated.retentionPolicy,
    status: updated.status,
    startedAtMs: updated.startedAtMs,
    updatedAtMs: args.next.finishedAtMs,
    finishedAtMs: args.next.finishedAtMs,
    ...(typeof updated.summary === 'string' && updated.summary.trim().length > 0 ? { summary: updated.summary } : {}),
    ...(updated.error?.code ? { errorCode: updated.error.code } : {}),
    resumeHandle,
  } as const;

  const markerWritePromise = args.enqueueMarkerWrite(args.runId, async (): Promise<void> => {
    // Disk writes can fail transiently (e.g. rename contention on some platforms). Retry once.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeExecutionRunMarker(markerPayload);
        return;
      } catch {
        if (attempt === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          continue;
        }
        return;
      }
    }
  });

  const trackedMarkerWritePromise = markerWritePromise.finally(() => {
    args.terminalMarkerWritePromises.delete(args.runId);
  });
  args.terminalMarkerWritePromises.set(args.runId, trackedMarkerWritePromise);
  const ctrl = args.controllers.get(args.runId) ?? null;
  if (ctrl) {
    ctrl.terminalMarkerWritePromise = trackedMarkerWritePromise;
  }

  const mergedMeta = (() => {
    const base = args.toolResult.meta ? { ...args.toolResult.meta } : {};
    if (resumeHandle) {
      (base as any).happierExecutionRun = {
        resumeHandle,
      };
    }
    return base;
  })();

  const profile = resolveExecutionRunIntentProfile(existing.intent);
  const shouldMaterializeInTranscript = profile.transcriptMaterialization !== 'none';
  if (shouldMaterializeInTranscript) {
    args.sendAcp(
      args.parentProvider,
      {
        type: 'tool-result',
        callId: existing.callId,
        output: args.toolResult.output,
        id: randomUUID(),
        ...(args.toolResult.isError ? { isError: true } : {}),
      },
      Object.keys(mergedMeta).length > 0 ? { meta: mergedMeta } : undefined,
    );
  }
}
