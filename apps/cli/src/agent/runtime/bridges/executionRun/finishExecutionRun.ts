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
import { readBackendResumableRuntimeId } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import {
  retainExecutionRunWorkerUpdate,
  retainExecutionRunState,
  writeExecutionRunMarker,
  type RetainedExecutionRunWorkerUpdate,
} from '@/daemon/executionRunRegistry';
import { composeExecutionRunWorkerUpdate } from './executionRunWorkerUpdate';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from '@happier-dev/protocol/runtime/agentSessionLimitsV1';
import { projectExecutionRunRequestedConfiguration } from '@happier-dev/protocol/execution/runs/requestedConfiguration';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ExecutionRunResumeHandle } from '@happier-dev/protocol';
import type { ExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';
import {
  createExecutionRunTranscriptCustodyError,
  isExecutionRunTranscriptCustodyError,
} from './executionRunTranscriptPublisher';
import { buildExecutionRunConnectedServicesCleanupReceipt } from './connectedServicesCleanupReceipt';
import type { ReviewRunCommentService } from '@/agent/executionRuns/profiles/review/reviewComments';
import { materializeReviewFindings } from './materializeReviewFindings';

// The same running state claims terminalization without exposing a terminal fact
// before its required ReviewComment writes. This replaces the old early status claim.
const terminalTransitionsInFlight = new WeakMap<Map<string, ExecutionRunState>, Set<string>>();

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
    | 'profileSourceCustody'
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
  toolResult: { output: unknown; isError?: boolean; meta?: Record<string, unknown> };
  structuredMeta?: ExecutionRunStructuredMeta;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  budgetRegistry: ExecutionBudgetRegistry | null;
  parentProvider: ACPProvider;
  sendAcp: ExecutionRunTranscriptPublisher;
  enqueueMarkerWrite: EnqueueMarkerWrite;
  terminalMarkerWritePromises: Map<string, Promise<void>>;
  onWorkerUpdateRetained?: (input: RetainedExecutionRunWorkerUpdate) => void;
  profileCatalog?: ExecutionRunProfileContributionCatalog;
  reviewComments?: ReviewRunCommentService;
}>): Promise<boolean> {
  const existing = args.runs.get(args.runId);
  if (!existing) return false;
  if (existing.status !== 'running') return false;
  const claimed = terminalTransitionsInFlight.get(args.runs) ?? new Set<string>();
  if (claimed.has(args.runId)) return false;
  terminalTransitionsInFlight.set(args.runs, claimed);
  claimed.add(args.runId);
  try {
  const terminalEventId = randomUUID();

  let toolResult = args.toolResult;
  let structuredMeta = args.structuredMeta;
  let terminalizationError: unknown = null;
  let shouldMaterializeInTranscript = false;
  try {
    const profile = args.profileCatalog
      ? resolveExecutionRunIntentProfileFromCatalog(args.profileCatalog, existing.intent, existing.profileId, existing.profileSourceCustody)
      : resolveExecutionRunIntentProfile(existing.intent);
    shouldMaterializeInTranscript = existing.sessionId !== null && profile.transcriptMaterialization !== 'none';
    if (args.next.status === 'failed' || args.next.status === 'cancelled') {
      const settled = await profile.onTerminal?.({ start: existing, status: args.next.status, finishedAtMs: args.next.finishedAtMs,
        structuredMeta: structuredMeta ?? existing.structuredMeta });
      if (settled) {
        structuredMeta = settled.structuredMeta;
        toolResult = { ...toolResult, output: settled.toolResultOutput,
          meta: { ...toolResult.meta, ...(structuredMeta ? { happier: structuredMeta } : {}) } };
      }
    }
  } catch (error) { terminalizationError = error; }
  const controller = args.controllers.get(args.runId);
  const workflowRunId = controller?.kind === 'backend'
    ? controller.workflowRunId ?? controller.workflowObservation?.workflowRunId : undefined;
  const projected = await materializeReviewFindings({ run: existing, toolResult, structuredMeta,
    expectFindings: args.next.status === 'succeeded' || (args.next.status === 'failed'
      && (args.structuredMeta?.kind === 'review_findings.v2' || args.structuredMeta?.kind === 'review_findings.v1')),
    reviewComments: args.reviewComments, workflowRunId });
  const materialization = projected.materialization;
  toolResult = projected.toolResult;
  structuredMeta = projected.structuredMeta;

  const resumeHandle: ExecutionRunResumeHandle | null = (() => {
    if (existing.retentionPolicy !== 'resumable') return null;
    const providerSessionId = readBackendResumableRuntimeId(args.controllers.get(args.runId) ?? null, existing.resumeHandle);
    if (typeof providerSessionId === 'string' && providerSessionId.trim().length > 0) {
      return { kind: 'provider_session.v1', backendTarget: readBackendTargetRefV2(existing.backendTarget), providerSessionId };
    }
    return existing.resumeHandle ?? null;
  })();

  let updated: ExecutionRunState = {
    ...existing,
    status: materialization && materialization.status !== 'materialized' ? 'failed' : args.next.status,
    summary: args.next.summary ?? existing.summary,
    finishedAtMs: args.next.finishedAtMs,
    ...(args.next.error ? { error: args.next.error } : {}),
    ...(materialization && materialization.status !== 'materialized'
      ? { error: { code: 'review_comment_materialization_failed', message: 'Review findings could not all be persisted' } }
      : {}),
    ...(structuredMeta ? { structuredMeta } : {}),
    latestToolResult: toolResult.output,
    ...(existing.retentionPolicy === 'resumable' ? { resumeHandle } : {}),
  };

  // Required comment materialization has completed before any terminal observation.
  args.runs.set(args.runId, updated);
  args.budgetRegistry?.releaseExecutionRun(args.runId);

  const mergedMeta = (() => {
    const base = toolResult.meta ? { ...toolResult.meta } : {};
    if (resumeHandle) {
      (base as any).happierExecutionRun = {
        resumeHandle,
      };
    }
    return base;
  })();
  if (!terminalizationError && shouldMaterializeInTranscript) {
    try {
      await args.sendAcp(
        args.parentProvider,
        {
          type: 'tool-result',
          callId: existing.callId,
          output: toolResult.output,
          id: terminalEventId,
          ...(toolResult.isError || updated.status === 'failed' ? { isError: true } : {}),
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

  const resultSizeBytes = readExecutionRunMarkerResultSizeBytes(toolResult.output);

  // Best-effort: update daemon-visible marker for machine-wide run visibility.
  const cleanupReceipt = buildExecutionRunConnectedServicesCleanupReceipt(
    updated.launch?.connectedServicesRegistration,
  );
  const requestedConfiguration = projectExecutionRunRequestedConfiguration({
    modelId: updated.launch?.modelSelection?.modelId ?? updated.launch?.modelId,
    sessionConfigOptionOverrides: updated.launch?.sessionConfigOptionOverrides,
  });
  const parentWorkerUpdate = composeExecutionRunWorkerUpdate(updated, terminalEventId);
  const markerPayload = {
    pid: process.pid,
    ...(updated.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: updated.requesterWorkAttributionV1 } : {}),
    happySessionId: existing.sessionId,
    runId: updated.runId,
    callId: updated.callId,
    sidechainId: updated.sidechainId,
    intent: updated.intent,
    backendTarget: readBackendTargetRefV2(updated.backendTarget),
    ...(updated.launch?.launchOrigin ? { launchOrigin: updated.launch.launchOrigin } : {}),
    ...(requestedConfiguration ? { requestedConfiguration } : {}),
    permissionMode: updated.permissionMode,
    retentionPolicy: updated.retentionPolicy,
    runClass: updated.runClass,
    ioMode: updated.ioMode,
    status: updated.status,
    ...(updated.notifyParentOnCompletion === true ? { notifyParentOnCompletion: true } : {}),
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
    await retainExecutionRunState(updated, terminalEventId);
    if (parentWorkerUpdate) {
      await retainExecutionRunWorkerUpdate({ ...parentWorkerUpdate,
        ...(updated.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: updated.requesterWorkAttributionV1 } : {}),
      });
      args.onWorkerUpdateRetained?.(parentWorkerUpdate);
    }
    // Disk writes can fail transiently (e.g. rename contention on some platforms). Retry once.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeExecutionRunMarker(markerPayload);
        return;
      } catch (error) {
        if (attempt === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          continue;
        }
        if (parentWorkerUpdate) throw error;
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

  // A parent completion is durable input, not merely daemon visibility.
  await trackedMarkerWritePromise;

  if (terminalizationError) throw terminalizationError;
  return true;
  } finally {
    claimed.delete(args.runId);
  }
}
