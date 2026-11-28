import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionHandoffActionResultV1Schema, type SessionHandoffActionResultV1 } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';
import { WorkspaceSyncPrepareBetweenResultV1Schema, type HandoffWorkspaceActionV1, type WorkspaceSyncPrepareBetweenResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { SESSION_HANDOFF_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { projectSessionHandoffFailureDetails } from '@happier-dev/protocol/actions/specs/session/lifecycle';
import type { OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';

/** The receiving Machine's typed refusal of a bare handoff that its isolation policy would sandbox (CLI `sessionHandoff/handlers.ts`). */
export const SESSION_HANDOFF_SANDBOX_PRESET_REQUIRED = 'handoff_target_requires_sandbox_preset';

type ExecuteAction = (actionId: 'session.handoff', input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;

type ExecuteSessionHandoffActionArgs = Readonly<{
  execute: ExecuteAction;
  sessionId: string;
  targetMachineId: string;
  targetPath?: string;
  targetSessionStorageMode?: 'direct' | 'persisted';
  stateTransfer?: 'transfer' | 'existing';
  workspaceAction?: HandoffWorkspaceActionV1;
  context: ActionExecutorContext;
}>;

export type ExecuteSessionHandoffActionResult =
  | Readonly<{ ok: true; result: SessionHandoffActionResultV1 }>
  | Readonly<{ ok: true; kind: 'approval_required'; artifactId: string }>
  | Readonly<{
      ok: false;
      error: string;
      errorCode?: string;
      failureCause?: ActionFailureCauseV1;
      effectAttempted?: boolean;
      details?: Extract<OpenProjectResultV1, { kind: 'refused' }>;
      recovery?: unknown;
      workspacePreparation?: Extract<WorkspaceSyncPrepareBetweenResultV1, { ok: false }>;
    }>;

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function executeSessionHandoffAction(
  args: ExecuteSessionHandoffActionArgs,
): Promise<ExecuteSessionHandoffActionResult> {
  const actionResult = await args.execute(
    SESSION_HANDOFF_ACTION_ID_V1,
    {
      sessionId: args.sessionId,
      targetMachineId: args.targetMachineId,
      ...(args.targetPath ? { targetPath: args.targetPath } : {}),
      ...(args.targetSessionStorageMode ? { targetSessionStorageMode: args.targetSessionStorageMode } : {}),
      ...(args.stateTransfer ? { stateTransfer: args.stateTransfer } : {}),
      ...(args.workspaceAction ? { workspaceAction: args.workspaceAction } : {}),
    },
    args.context,
  );
  if (!actionResult.ok) {
    const handoffDetails = projectSessionHandoffFailureDetails(SESSION_HANDOFF_ACTION_ID_V1, actionResult);
    const detail = args.workspaceAction?.kind === 'linked_workspace'
      ? WorkspaceSyncPrepareBetweenResultV1Schema.safeParse(actionResult.details)
      : null;
    return {
      ok: false,
      error: normalizeNonEmptyString(actionResult.error) ?? 'failed_to_start_session_handoff',
      ...(actionResult.failureCause ? { failureCause: actionResult.failureCause } : {}),
      ...(actionResult.effectAttempted === undefined ? {} : { effectAttempted: actionResult.effectAttempted }),
      ...(handoffDetails && 'kind' in handoffDetails ? { details: handoffDetails } : {}),
      ...(normalizeNonEmptyString(actionResult.errorCode) ? { errorCode: actionResult.errorCode } : {}),
      ...(detail?.success && !detail.data.ok ? { workspacePreparation: detail.data } : {}),
    };
  }

  const deferredApproval = ActionApprovalRequestCreatedResultSchema.safeParse(actionResult.result);
  if (deferredApproval.success) {
    return { ok: true, kind: 'approval_required', artifactId: deferredApproval.data.artifactId };
  }

  const terminalResult = SessionHandoffActionResultV1Schema.safeParse(actionResult.result);
  return terminalResult.success
    ? { ok: true, result: terminalResult.data }
    : { ok: false, error: 'unsupported_session_handoff_result' };
}
