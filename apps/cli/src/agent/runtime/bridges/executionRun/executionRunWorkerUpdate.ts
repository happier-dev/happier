import { composeExecutionRunWorkerUpdateV1, SessionUpdatePostInputV1Schema, workerDeliverableResultMaxLengthV1, workerDeliverablesBelongToSessionV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import type { RetainedExecutionRunWorkerUpdate } from '@/daemon/executionRunRegistry';
import type { ExecutionRunState } from './executionRunTypes';
import { resolveWorkerUpdateFollowDeliveryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

/** A projection of canonical terminal Run state; no additional result or status owner. */
export function composeExecutionRunWorkerUpdate(run: ExecutionRunState, terminalEventId: string): RetainedExecutionRunWorkerUpdate | null {
  if (!run.sessionId || run.status === 'running' || run.notifyParentOnCompletion !== true) return null;
  const parsed = SessionUpdatePostInputV1Schema.safeParse(run.latestToolResult);
  const report = parsed.success && workerDeliverablesBelongToSessionV1(parsed.data.deliverables, run.sessionId) ? parsed.data : null;
  const deliverables = report?.deliverables;
  const summary = run.latestToolResult && typeof run.latestToolResult === 'object'
    && 'summary' in run.latestToolResult && typeof run.latestToolResult.summary === 'string'
    ? run.latestToolResult.summary : null;
  const result = report ? report.summary : typeof run.latestToolResult === 'string' ? run.latestToolResult
    : summary ?? (run.latestToolResult !== undefined ? JSON.stringify(run.latestToolResult) ?? ''
      : run.summary ?? run.error?.message ?? '');
  const resultMaxLength = workerDeliverableResultMaxLengthV1(deliverables);
  const update = composeExecutionRunWorkerUpdateV1({
    runId: run.runId, sessionId: run.sessionId, status: run.status,
    ...((run.status === 'failed' || run.status === 'timeout') && run.error?.runtimeIssueV1
      ? { runtimeIssueV1: run.error.runtimeIssueV1 } : {}),
    ...(run.effectiveEngine ? { engine: run.effectiveEngine } : {}),
    result: result.slice(0, resultMaxLength),
    ...(deliverables ? { deliverables } : {}),
    ...(result.length > resultMaxLength ? { truncated: true } : {}),
    canInspect: run.retentionPolicy === 'resumable',
  });
  // Only retained predecessor runs lack a captured policy. New starts bind it
  // before any native effect; failure to read fresh defaults cannot reach here.
  const runReportPolicy = run.runReportPolicy ?? { preset: 'important' as const };
  if (!resolveWorkerUpdateFollowDeliveryV1({ update, policies: [runReportPolicy] })?.selected) return null;
  return { sessionId: run.sessionId, localId: `execution-run-worker-update:${terminalEventId}`, update,
    ...(run.runReportPolicy ? { runReportPolicy } : {}) };
}
