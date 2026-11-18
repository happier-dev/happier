import { isWorkspaceSyncRelationshipWriteActionId } from '../../actionIds.js';
import { isRpcMethodNotFoundError } from '../../../rpc/errors.js';
import type { WorkspaceSyncConflictResolveActionInputV1Schema, WorkspaceSyncConflictsListActionInputV1Schema, WorkspaceSyncConflictInspectActionInputV1Schema, WorkspaceSyncRelationshipsListActionInputV1Schema, WorkspaceSyncRelationshipWriteActionInputV1Schema, WorkspaceSyncRelationshipDisableActionInputV1Schema, WorkspaceSyncRelationshipEnableActionInputV1Schema, WorkspaceSyncRelationshipFlushActionInputV1Schema, WorkspaceSyncRelationshipTerminateActionInputV1Schema } from '../../../sessions/control/handoff/workspaceSyncSchemas.js';
import { completeActionResult } from '../resultProjection.js';
import { normalizeId } from '../inputReading.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';
import type { z } from '../../../zodRuntimePolicy.js';



export async function dispatchWorkspaceSync(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'ctx' | 'parsed'>): Promise<ActionExecuteResult | null> {
  try {
    return await executeWorkspaceSync(inv);
  } catch (error) {
    if (!isRpcMethodNotFoundError(error)) throw error;
    return { ok: false, errorCode: 'workspace_sync_update_required', error: 'workspace_sync_update_required', effectAttempted: false };
  }
}

async function executeWorkspaceSync(inv: Parameters<typeof dispatchWorkspaceSync>[0]): Promise<ActionExecuteResult | null> {
  const { actionId, deps, ctx, parsed } = inv;

        if (actionId === 'workspace.sync.conflict.resolve') {
          if (!deps.workspaceSyncConflictResolve) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.sync.conflict.resolve' };
          }
          if (!ctx.actionRequestId) {
            return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
          }
          const res = await deps.workspaceSyncConflictResolve({
            actionReceiptId: ctx.actionRequestId,
            context: ctx,
            input: parsed.data as z.infer<typeof WorkspaceSyncConflictResolveActionInputV1Schema>,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (isWorkspaceSyncRelationshipWriteActionId(actionId)) {
          if (!deps.workspaceSyncRelationshipCreate) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.sync.relationship.create' };
          }
          // Relationship identity is derived from the admitted Action request,
          // never from a caller-supplied value: the target daemon re-derives
          // the same rule to authorize a destructive destination.
          const operationId = normalizeId(ctx.handoffTargetReplacementApproval?.operationId)
            || normalizeId(ctx.actionRequestId);
          if (!operationId) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const res = await deps.workspaceSyncRelationshipCreate({
            input: parsed.data as z.infer<typeof WorkspaceSyncRelationshipWriteActionInputV1Schema>,
            operationId,
            ...(normalizeId(ctx.serverIdentityId) ? { serverIdentityId: normalizeId(ctx.serverIdentityId) } : {}),
            ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}),
            ...(ctx.handoffTargetReplacementApproval && ctx.handoffTargetReplacementApprovalReceiptId
              ? {
                  targetReplacementApproval: ctx.handoffTargetReplacementApproval,
                  targetReplacementApprovalReceiptId: ctx.handoffTargetReplacementApprovalReceiptId,
                }
              : {}),
            context: ctx,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res, { treatReturnedErrorEnvelopeAsFailure: true });
        }

        if (actionId === 'workspace.sync.relationship.terminate') {
          if (!deps.workspaceSyncRelationshipTerminate) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.sync.relationship.terminate' };
          }
          const res = await deps.workspaceSyncRelationshipTerminate({
            input: parsed.data as z.infer<typeof WorkspaceSyncRelationshipTerminateActionInputV1Schema>,
            context: ctx,
            ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res, { treatReturnedErrorEnvelopeAsFailure: true });
        }

        if (actionId === 'workspace.sync.relationship.disable') {
          if (!deps.workspaceSyncRelationshipDisable) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.sync.relationship.disable' };
          const res = await deps.workspaceSyncRelationshipDisable({ input: parsed.data as z.infer<typeof WorkspaceSyncRelationshipDisableActionInputV1Schema>,
            context: ctx,
            ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
          return completeActionResult(res, { treatReturnedErrorEnvelopeAsFailure: true });
        }

        if (actionId === 'workspace.sync.relationship.enable') {
          if (!deps.workspaceSyncRelationshipEnable) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.sync.relationship.enable' };
          const res = await deps.workspaceSyncRelationshipEnable({ input: parsed.data as z.infer<typeof WorkspaceSyncRelationshipEnableActionInputV1Schema>,
            context: ctx,
            ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
          return completeActionResult(res, { treatReturnedErrorEnvelopeAsFailure: true });
        }

        if (actionId === 'workspace.sync.relationship.flush') {
          if (!deps.workspaceSyncRelationshipFlush) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.sync.relationship.flush' };
          const res = await deps.workspaceSyncRelationshipFlush({ input: parsed.data as z.infer<typeof WorkspaceSyncRelationshipFlushActionInputV1Schema>,
            context: ctx,
            ...(normalizeId(ctx.serverId) ? { serverId: normalizeId(ctx.serverId) } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
          return completeActionResult(res, { treatReturnedErrorEnvelopeAsFailure: true });
        }

        if (actionId === 'workspace.sync.relationships.list') {
          if (!deps.workspaceSyncRelationshipsList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.sync.relationships.list' };
          }
          const res = await deps.workspaceSyncRelationshipsList({
            context: ctx,
            input: parsed.data as z.infer<typeof WorkspaceSyncRelationshipsListActionInputV1Schema>,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res, { treatReturnedErrorEnvelopeAsFailure: true });
        }

        if (actionId === 'workspace.sync.conflicts.list') {
          if (!deps.workspaceSyncConflictsList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.sync.conflicts.list' };
          }
          const res = await deps.workspaceSyncConflictsList({
            context: ctx,
            input: parsed.data as z.infer<typeof WorkspaceSyncConflictsListActionInputV1Schema>,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'workspace.sync.conflict.inspect') {
          if (!deps.workspaceSyncConflictInspect) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workspace.sync.conflict.inspect' };
          }
          const res = await deps.workspaceSyncConflictInspect({
            context: ctx,
            input: parsed.data as z.infer<typeof WorkspaceSyncConflictInspectActionInputV1Schema>,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }
  return null;
}
