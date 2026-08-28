import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import {
  resolveExecutionRunIntentProfile,
  resolveExecutionRunIntentProfileFromCatalog,
  type ExecutionRunProfileContributionCatalog,
} from '@/agent/executionRuns/profiles/intentRegistry';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { readBackendResumableChildSessionId } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { writeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import {
  AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1,
  readBackendTargetRefV2,
  type ExecutionRunResumeHandle,
} from '@happier-dev/protocol';
import type { ExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';
import {
  createExecutionRunTranscriptCustodyError,
  isExecutionRunTranscriptCustodyError,
} from './executionRunTranscriptPublisher';
import { buildExecutionRunConnectedServicesCleanupReceipt } from './connectedServicesCleanupReceipt';

type EnqueueMarkerWrite = (runId: string, write: () => Promise<void>) => Promise<void>;

function readExecutionRunMarkerResultSizeBytes(value: unknown): number | undefined {
  let serialized: string | undefined;
  if (typeof value === 'string') {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  if (serialized === undefined) return undefined;

  const sizeBytes = Buffer.byteLength(serialized, 'utf8');
  return sizeBytes <= AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates.sendRequestMaxJsonBytes
    ? sizeBytes
    : undefined;
}

type FinishRunNext = Omit<
  ExecutionRunState,
  | 'runId'
  | 'callId'
  | 'sidechainId'
    | 'sessionId'
    | 'depth'
    | 'intent'
    | 'profileId'
    | 'backendTarget'
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

export async function finishExecutionRun(args: Readonly<{
  runId: string;
  next: FinishRunNext;
  toolResult: { output: any; isError?: boolean; meta?: Record<string, unknown> };
  structuredMeta?: ExecutionRunStructuredMeta;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  parentProvider: ACPProvider;
  sendAcp: ExecutionRunTranscriptPublisher;
  enqueueMarkerWrite: EnqueueMarkerWrite;
  terminalMarkerWritePromises: Map<string, Promise<void>>;
  profileCatalog?: ExecutionRunProfileContributionCatalog;
}>): Promise<boolean> {
  const existing = args.runs.get(args.runId);
  if (!existing) return false;
  if (existing.status !== 'running') return false;

  const resumeHandle: ExecutionRunResumeHandle | null = (() => {
    if (existing.retentionPolicy !== 'resumable') return null;
    const providerSessionId = readBackendResumableChildSessionId(args.controllers.get(args.runId) ?? null);
    if (typeof providerSessionId === 'string' && providerSessionId.trim().length > 0) {
      return { kind: 'provider_session.v1', backendTarget: readBackendTargetRefV2(existing.backendTarget), providerSessionId };
    }
    return existing.resumeHandle ?? null;
  })();

  let updated: ExecutionRunState = {
    ...existing,
    status: args.next.status,
    summary: args.next.summary ?? existing.summary,
    finishedAtMs: args.next.finishedAtMs,
    ...(args.next.error ? { error: args.next.error } : {}),
    ...(args.structuredMeta ? { structuredMeta: args.structuredMeta } : {}),
    latestToolResult: args.toolResult.output,
    ...(existing.retentionPolicy === 'resumable' ? { resumeHandle } : {}),
  };

  // Claim the single terminal transition before any publication await. Every competing
  // terminalizer observes this state and converges without publishing another terminal fact.
  args.runs.set(args.runId, updated);
  args.budgetRegistry?.releaseExecutionRun(args.runId);

  const mergedMeta = (() => {
    const base = args.toolResult.meta ? { ...args.toolResult.meta } : {};
    if (resumeHandle) {
      (base as any).happierExecutionRun = {
        resumeHandle,
      };
    }
    return base;
  })();
  let terminalizationError: unknown = null;
  let shouldMaterializeInTranscript = false;
  try {
    const profile = args.profileCatalog
      ? resolveExecutionRunIntentProfileFromCatalog(args.profileCatalog, existing.intent, existing.profileId)
      : resolveExecutionRunIntentProfile(existing.intent);
    shouldMaterializeInTranscript = existing.sessionId !== null
      && profile.transcriptMaterialization !== 'none';
  } catch (error) {
    terminalizationError = error;
  }
  if (!terminalizationError && shouldMaterializeInTranscript) {
    try {
      await args.sendAcp(
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
    } catch {
      terminalizationError = createExecutionRunTranscriptCustodyError();
    }
  }
  if (terminalizationError) {
    if (isExecutionRunTranscriptCustodyError(terminalizationError)) {
      const publicationError = terminalizationError as ReturnType<typeof createExecutionRunTranscriptCustodyError>;
      updated = {
        ...updated,
        status: 'failed',
        summary: publicationError.message,
        error: { code: publicationError.code, message: publicationError.message },
      };
    } else {
      const message = terminalizationError instanceof Error ? terminalizationError.message : 'Execution failed';
      updated = {
        ...updated,
        status: 'failed',
        summary: args.next.status === 'failed' ? updated.summary : message,
        error: args.next.status === 'failed' && updated.error
          ? updated.error
          : { code: 'execution_run_failed', message },
      };
    }
  }
  args.runs.set(args.runId, updated);

  const resultSizeBytes = readExecutionRunMarkerResultSizeBytes(args.toolResult.output);

  // Best-effort: update daemon-visible marker for machine-wide run visibility.
  const cleanupReceipt = buildExecutionRunConnectedServicesCleanupReceipt(
    updated.launch?.connectedServicesRegistration,
  );
  const markerPayload = {
    pid: process.pid,
    happySessionId: existing.sessionId,
    runId: updated.runId,
    callId: updated.callId,
    sidechainId: updated.sidechainId,
    intent: updated.intent,
    backendTarget: readBackendTargetRefV2(updated.backendTarget),
    permissionMode: updated.permissionMode,
    retentionPolicy: updated.retentionPolicy,
    runClass: updated.runClass,
    ioMode: updated.ioMode,
    status: updated.status,
    startedAtMs: updated.startedAtMs,
    updatedAtMs: args.next.finishedAtMs,
    finishedAtMs: args.next.finishedAtMs,
    ...(updated.error?.code ? { errorCode: updated.error.code } : {}),
    ...(resultSizeBytes === undefined ? {} : { resultSizeBytes }),
    ...(cleanupReceipt
      ? { executionRunConnectedServicesCleanupReceiptV1: cleanupReceipt }
      : {}),
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

  if (terminalizationError) throw terminalizationError;
  return true;
}
