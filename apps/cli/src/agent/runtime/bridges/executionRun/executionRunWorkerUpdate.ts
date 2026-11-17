import { composeExecutionRunWorkerUpdateV1, SessionUpdatePostInputV1Schema, workerDeliverableResultMaxLengthV1, workerDeliverablesBelongToSessionV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import type { RetainedExecutionRunWorkerUpdate } from '@/daemon/executionRunRegistry';
import type { ExecutionRunState } from './executionRunTypes';
import { resolveWorkerUpdateFollowDeliveryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { readSessionRuntimeIssueCode, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { projectSessionRuntimeIssueMetadataV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueMetadataV1';

/** A projection of canonical terminal Run state; no additional result or status owner. */
export function composeExecutionRunWorkerUpdate(run: ExecutionRunState, terminalEventId: string): RetainedExecutionRunWorkerUpdate | null {
  if (!run.sessionId || run.status === 'running' || run.notifyParentOnCompletion !== true) return null;
  const failed = run.status === 'failed' || run.status === 'timeout';
  const failure = run.error;
  const runtimeIssueV1: SessionRuntimeIssueV1 | undefined = failed
    ? failure?.runtimeIssueV1 ?? {
      v: 1, scope: 'primary_session', status: 'failed', source: 'unknown',
      occurredAt: run.finishedAtMs ?? run.startedAtMs,
      code: readSessionRuntimeIssueCode(failure?.code) ?? 'execution_run_failed',
    } : undefined;
  const parsed = SessionUpdatePostInputV1Schema.safeParse(run.latestToolResult);
  const report = parsed.success && workerDeliverablesBelongToSessionV1(parsed.data.deliverables, run.sessionId) ? parsed.data : null;
  const deliverables = report?.deliverables;
  const summary = run.latestToolResult && typeof run.latestToolResult === 'object'
    && 'summary' in run.latestToolResult && typeof run.latestToolResult.summary === 'string'
    ? run.latestToolResult.summary : null;
  // A Run error can be mirrored in the tool envelope and summary. A validated
  // worker report carries its own authored output separately from that error.
  const result = report ? report.summary : failed ? undefined : typeof run.latestToolResult === 'string' ? run.latestToolResult
    : summary ?? (run.latestToolResult !== undefined ? JSON.stringify(run.latestToolResult) ?? ''
      : run.summary ?? '');
  const resultMaxLength = workerDeliverableResultMaxLengthV1(deliverables);
  const update = composeExecutionRunWorkerUpdateV1({
    runId: run.runId, sessionId: run.sessionId, status: run.status,
    ...(runtimeIssueV1 ? { runtimeIssueV1: projectSessionRuntimeIssueMetadataV1(runtimeIssueV1) } : {}),
    ...(run.effectiveEngine ? { engine: run.effectiveEngine } : {}),
    ...(result === undefined ? {} : { result: result.slice(0, resultMaxLength) }),
    ...(deliverables ? { deliverables } : {}),
    ...(result !== undefined && result.length > resultMaxLength ? { truncated: true } : {}),
    canInspect: run.retentionPolicy === 'resumable',
  });
  // Only retained predecessor runs lack a captured policy. New starts bind it
  // before any native effect; failure to read fresh defaults cannot reach here.
  const runReportPolicy = run.runReportPolicy ?? { preset: 'important' as const };
  if (!resolveWorkerUpdateFollowDeliveryV1({ update, policies: [runReportPolicy] })?.selected) return null;
  return { sessionId: run.sessionId, localId: `execution-run-worker-update:${terminalEventId}`, update,
    ...(run.runReportPolicy ? { runReportPolicy } : {}) };
}
