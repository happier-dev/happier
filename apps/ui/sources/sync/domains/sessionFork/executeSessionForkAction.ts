import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol';

type ExecuteAction = (actionId: 'session.fork', input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;

type ExecuteSessionForkActionArgs = Readonly<{
  execute: ExecuteAction;
  sessionId: string;
  context: ActionExecutorContext;
}>;

type ExecuteSessionForkActionResult =
  | Readonly<{ ok: true; childSessionId: string }>
  | Readonly<{ ok: false; error: string }>;

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function executeSessionForkAction(args: ExecuteSessionForkActionArgs): Promise<ExecuteSessionForkActionResult> {
  const actionResult = await args.execute('session.fork', { sessionId: args.sessionId }, args.context);
  if (!actionResult.ok) {
    return { ok: false, error: normalizeNonEmptyString(actionResult.error) ?? 'failed_to_fork_session' };
  }

  const forkResult = actionResult.result as any;
  if (forkResult?.ok !== true) {
    return {
      ok: false,
      error:
        normalizeNonEmptyString(forkResult?.errorMessage)
        ?? normalizeNonEmptyString(forkResult?.error)
        ?? 'failed_to_fork_session',
    };
  }

  const childSessionId = normalizeNonEmptyString(forkResult?.childSessionId);
  if (!childSessionId) {
    return { ok: false, error: 'failed_to_fork_session' };
  }

  return { ok: true, childSessionId };
}
