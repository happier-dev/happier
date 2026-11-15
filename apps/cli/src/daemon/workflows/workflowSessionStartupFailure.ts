import { ActionOperationSnapshotV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionCompletionOperation } from '@happier-dev/protocol/actions/actionCompletion';
import { SPAWN_SESSION_ERROR_CODES, SessionLaunchRetiredV1Schema, normalizeSpawnSessionErrorDetail } from '@happier-dev/protocol/spawnSession';
import { isDefiniteSpawnPreAdmissionRejection } from '@/session/services/spawnPreAdmissionRejection';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { WorkflowSessionCompositionError } from './workflowConversation';
import { SessionSpawnNewActionResultV1Schema, type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { readSessionRuntimeFailureCause } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { projectSessionRuntimeIssueMetadataV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueMetadataV1';

/** Retain the creator's existing typed projection, including its retry decision. */
export function readWorkflowSessionStartupRefusal(error: unknown): Extract<SessionSpawnNewResultV1, { type: 'error' }> | undefined {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string'
    || !('details' in error) || !error.details || typeof error.details !== 'object') return undefined;
  const details = error.details;
  const response = 'spawnResponse' in details ? details.spawnResponse : undefined;
  const errorDetail = 'errorDetail' in details ? details.errorDetail
    : response && typeof response === 'object' && 'errorDetail' in response ? response.errorDetail : undefined;
  const detail = normalizeSpawnSessionErrorDetail(errorDetail);
  // An unclassified failure does not prove launch retirement. Its original
  // internal error, including nonce/transport uncertainty, must remain intact.
  if (!detail || detail.kind === 'launch_retired') return undefined;
  const originalCode = response && typeof response === 'object' && 'errorCode' in response
    && typeof response.errorCode === 'string' ? response.errorCode : error.code;
  return projectSessionSpawnFailure({ errorCode: originalCode, errorMessage: error.message, errorDetail: detail,
    ...('agentId' in details ? { agentId: details.agentId } : {}) });
}

/** Native classification stays at its producer; Workflow carries only non-content recovery facts. */
function workflowSessionStartupRefusalError(
  refusal: Extract<SessionSpawnNewResultV1, { type: 'error' }>, occurredAt: number,
): WorkflowSessionCompositionError {
  const launch = 'launchError' in refusal ? refusal.launchError : undefined;
  const code = launch?.code ?? ('providerError' in refusal ? refusal.providerError?.code : undefined) ?? refusal.code;
  const providerCause = 'providerError' in refusal ? readSessionRuntimeFailureCause(refusal.providerError, 'client_start') : undefined;
  const actionFailureCause = ('failureCause' in refusal ? refusal.failureCause : undefined) ?? providerCause?.actionCause;
  if (actionFailureCause && !launch && !('providerError' in refusal && refusal.providerError)) {
    return new WorkflowSessionCompositionError(code, code, undefined, undefined, undefined, actionFailureCause);
  }
  const failureCause = { phase: 'client_start' as const, failureReason: 'unknown' as const,
    code, retryable: refusal.retryable, ...(launch?.failureCause ?? providerCause) };
  const runtimeIssueV1 = projectSessionRuntimeIssueMetadataV1({ v: 1, scope: 'primary_session', status: 'failed',
    code, source: failureCause.failureReason === 'usage_limit' ? 'usage_limit' : 'unknown', occurredAt, failureCause,
    ...('agentId' in refusal && refusal.agentId ? { agentId: refusal.agentId } : {}) });
  return new WorkflowSessionCompositionError(code, code, undefined, undefined, runtimeIssueV1, actionFailureCause);
}

/** Both live observation and cold recovery consume the original operation's typed result. */
export function readWorkflowSessionStartupError(operation: ActionOperationSnapshotV1): WorkflowSessionCompositionError | (Error & Readonly<{ code: string }>) {
  const result = SessionSpawnNewActionResultV1Schema.safeParse(operation.result);
  if (result.success && result.data.type === 'error') {
    return workflowSessionStartupRefusalError(result.data, operation.settledAt ?? operation.createdAt);
  }
  const code = operation.error?.errorCode ?? 'workflow_session_startup_unavailable';
  // A failed observer is not proof that its native launch retired. Only the
  // creator's typed refusal or exact retirement can close Workflow custody.
  if (code === SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED) {
    return Object.assign(new Error(operation.error?.error ?? code), { code });
  }
  return new WorkflowSessionCompositionError(code);
}

/** Only the creator's typed response settles a definite startup refusal. */
export function rethrowWorkflowSessionStartupFailure(error: unknown, spawnNonce?: string): never {
  if (error instanceof Error && 'code' in error && error.code === SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED
    && 'details' in error && error.details && typeof error.details === 'object') {
    const details = error.details;
    const response = 'spawnResponse' in details ? details.spawnResponse : undefined;
    const retired = SessionLaunchRetiredV1Schema.safeParse('errorDetail' in details ? details.errorDetail
      : response && typeof response === 'object' && 'errorDetail' in response ? response.errorDetail : undefined);
    if (retired.success && retired.data.spawnNonce === spawnNonce) {
      throw new WorkflowSessionCompositionError(error.code, error.code, undefined, retired.data);
    }
  }
  const refusal = readWorkflowSessionStartupRefusal(error);
  if (refusal) throw workflowSessionStartupRefusalError(refusal, Date.now());
  // Transport loss and nonce observation remain unresolved; a definite daemon
  // refusal retains its code through the Workflow's existing failure presenter.
  if (error instanceof Error && 'code' in error && 'details' in error
    && typeof error.code === 'string' && isDefiniteSpawnPreAdmissionRejection(error.code)) {
    const response = error.details;
    if (response && typeof response === 'object' && 'type' in response && response.type === 'error'
      && 'errorCode' in response && response.errorCode === error.code) {
      throw new WorkflowSessionCompositionError(error.code);
    }
  }
  throw error;
}

/** Terminal startup failure remains a fact after its process-local owner retires. */
export function readRetainedWorkflowSessionStartupFailure(
  snapshot: unknown, address: ActionCompletionOperation, creationKey: string,
): ActionOperationSnapshotV1 | undefined {
  const parsed = ActionOperationSnapshotV1Schema.safeParse(snapshot);
  return parsed.success && parsed.data.state === 'failed' && parsed.data.operationId === address.operationId
    && parsed.data.actionId === 'session.spawn_new' && parsed.data.scope.machineId === address.machineId
    && parsed.data.requestId === creationKey
    && readWorkflowSessionStartupError(parsed.data) instanceof WorkflowSessionCompositionError ? parsed.data : undefined;
}
