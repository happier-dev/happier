import type {
  ActionExecuteResult,
  ActionExecutorContext,
  SessionHandoffWorkspaceTransfer,
} from '@happier-dev/protocol';

type ExecuteAction = (actionId: 'session.handoff', input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;

type ExecuteSessionHandoffActionArgs = Readonly<{
  execute: ExecuteAction;
  sessionId: string;
  targetMachineId: string;
  targetSessionStorageMode?: 'direct' | 'persisted';
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
  context: ActionExecutorContext;
}>;

type ExecuteSessionHandoffActionResult =
  | Readonly<{ ok: true; handoffId: string }>
  | Readonly<{ ok: false; error: string; recovery?: unknown }>;

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
      ...(args.targetSessionStorageMode ? { targetSessionStorageMode: args.targetSessionStorageMode } : {}),
      ...(args.workspaceTransfer ? { workspaceTransfer: args.workspaceTransfer } : {}),
    },
    args.context,
  );
  if (!actionResult.ok) {
    return { ok: false, error: normalizeNonEmptyString(actionResult.error) ?? 'failed_to_start_session_handoff' };
  }

  const handoffResult = actionResult.result as any;
  if (handoffResult?.ok !== true) {
    return {
      ok: false,
      error:
        normalizeNonEmptyString(handoffResult?.errorMessage)
        ?? normalizeNonEmptyString(handoffResult?.error)
        ?? 'failed_to_start_session_handoff',
      ...(handoffResult?.recovery ? { recovery: handoffResult.recovery } : {}),
    };
  }

  const handoffId = normalizeNonEmptyString(handoffResult?.handoffId);
  if (!handoffId) {
    return { ok: false, error: 'failed_to_start_session_handoff' };
  }

  return { ok: true, handoffId };
}
