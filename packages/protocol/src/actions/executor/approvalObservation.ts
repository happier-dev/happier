import { ActionIdSchema } from '../actionIds.js';
import { projectApprovalRequestForPublicRead } from '../actionApprovalPresentation.js';
import type { ActionExecuteResult } from '../actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../../approvals/approvalRequestV1.js';
import { WorkspaceSyncRelationshipCreateActionInputV1Schema, WorkspaceSyncRelationshipCreationObservationV1Schema } from '../../sessions/control/handoff/workspaceSyncSchemas.js';
import { isApprovalArtifactObservationGrantedV1, readApprovalArtifactObservationRequestV1,
  readApprovalArtifactObservationSubjectV1 } from '../../approvals/approvalArtifactHeaderV1.js';

function readApprovalRequestStatus(raw: unknown): ApprovalRequest['status'] | null {
  return raw === 'open' || raw === 'approved' || raw === 'rejected'
    || raw === 'executed' || raw === 'failed' || raw === 'canceled' ? raw : null;
}

async function reconcileWorkspaceLink(request: ApprovalRequest, artifactId: string, context: ActionExecutorContext,
  deps: Pick<ActionExecutorDeps, 'workspaceSyncRelationshipObserveCreation' | 'approvalsUpdate'>): Promise<ApprovalRequest> {
  if (request.v !== 2 || request.actionId !== 'workspace.sync.relationship.create'
    || request.status !== 'outcome_unknown' || request.execution?.effectAttempted !== true
    || !deps.workspaceSyncRelationshipObserveCreation || !deps.approvalsUpdate) return request;
  const input = WorkspaceSyncRelationshipCreateActionInputV1Schema.safeParse(request.actionArgs);
  if (!input.success || input.data.purpose !== 'worker_clean_copy') return request;
  try {
    const observed = WorkspaceSyncRelationshipCreationObservationV1Schema.parse(await deps.workspaceSyncRelationshipObserveCreation({
      input: input.data,
      operationId: request.handoffTargetReplacementApproval?.operationId ?? request.executionOriginV1.requestId,
      serverId: request.executionOriginV1.serverIdentityId ?? request.executionOriginV1.serverId,
      ...(context.signal ? { signal: context.signal } : {}),
    }));
    if (observed.outcome === 'unknown') return request;
    const next = ApprovalRequestV2Schema.parse({ ...request, updatedAtMs: Math.max(Date.now(), request.updatedAtMs),
      status: observed.outcome === 'succeeded' ? 'executed' : 'failed',
      execution: { executedAtMs: request.execution.executedAtMs, effectAttempted: true,
        ...(observed.outcome === 'succeeded' ? { ok: true, result: observed }
          : { ok: false, errorCode: observed.errorCode, error: observed.errorCode }) },
    });
    const updated = await deps.approvalsUpdate({ artifactId, request: next, serverId: request.executionOriginV1.serverId });
    return updated.ok ? next : request;
  } catch { return request; }
}

/** Public observation shares the private queue's body-authoritative scope owner. */
export async function executeApprovalObservationAction(params: Readonly<{
  actionId: 'approval.request.list' | 'approval.request.get';
  input: Readonly<Record<string, unknown>>;
  context: ActionExecutorContext;
  deps: Pick<ActionExecutorDeps, 'approvalsList' | 'approvalsGet' | 'approvalsUpdate' | 'workspaceSyncRelationshipObserveCreation' | 'resolveApiTokenGrantSessionMachineId'>;
}>): Promise<ActionExecuteResult> {
  const { actionId, input, context, deps } = params;
  const serverId = context.serverId?.trim() || null;
  const sessionId = context.externalActionTarget?.kind === 'session' ? context.externalActionTarget.sessionId : null;
  const grant = context.externalActionCredential?.grant;
  const resolveSessionMachine = deps.resolveApiTokenGrantSessionMachineId;
  const resolveSessionMachineId = resolveSessionMachine
    ? (sessionId: string) => resolveSessionMachine({ actionId, sessionId, context }) : undefined;
  if (actionId === 'approval.request.list') {
    if (!deps.approvalsList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
    const listed = await deps.approvalsList({
      status: readApprovalRequestStatus(input.status),
      ...(typeof input.workflowRunId === 'string' ? { workflowRunId: input.workflowRunId } : {}),
      ...(typeof input.actionId === 'string' ? { actionId: ActionIdSchema.parse(input.actionId) } : {}),
      ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
      limit: typeof input.limit === 'number' ? input.limit : null,
      // Run correspondence is portable across device-local Home profile ids.
      // V1 queue history keeps its incumbent profile-scoped selection.
      serverId: typeof input.workflowRunId === 'string' ? context.serverIdentityId?.trim() || serverId : serverId,
      ...(sessionId ? { sessionId } : {}),
      ...(grant?.targets ? { targetGrant: grant, ...(resolveSessionMachineId ? { resolveSessionMachineId } : {}) } : {}),
    });
    return { ok: true, result: listed };
  }
  if (!deps.approvalsGet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
  const artifactId = typeof input.artifactId === 'string' ? input.artifactId.trim() : '';
  if (!artifactId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  const request = await deps.approvalsGet({ artifactId, serverId });
  const parsed = request ? readApprovalArtifactObservationRequestV1(request) : null;
  if (!parsed || sessionId && readApprovalArtifactObservationSubjectV1(parsed).sessionId !== sessionId
    || !await isApprovalArtifactObservationGrantedV1(parsed, grant, resolveSessionMachineId)) {
    return { ok: false, errorCode: 'approval_not_found', error: 'approval_not_found' };
  }
  const observed = parsed.family === 'built_in' ? await reconcileWorkspaceLink(parsed.request, artifactId, context, deps) : parsed.request;
  return { ok: true, result: { artifactId, request: projectApprovalRequestForPublicRead(observed),
    queryPlan: { kind: 'approval_artifact_id_lookup', backingStore: 'ArtifactStore',
      boundedBy: 'approval artifact id', hydratedTranscripts: false } } };
}
