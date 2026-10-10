import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionHandoffActionResultV1Schema, type SessionHandoffActionResultV1 } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';
import { WorkspaceSyncPrepareBetweenResultV1Schema, type HandoffWorkspaceActionV1, type WorkspaceSyncPrepareBetweenResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

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
    'session.handoff',
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
    const detail = args.workspaceAction?.kind === 'linked_workspace'
      ? WorkspaceSyncPrepareBetweenResultV1Schema.safeParse(actionResult.details)
      : null;
    return {
      ok: false,
      error: normalizeNonEmptyString(actionResult.error) ?? 'failed_to_start_session_handoff',
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
