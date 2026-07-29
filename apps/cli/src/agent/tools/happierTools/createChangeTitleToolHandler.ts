import type { ActionId } from '@happier-dev/protocol';

type ActionExecutorResult = Readonly<
  | { ok: true; result: unknown }
  | { ok: false; errorCode: string; error: string }
>;

type ActionExecutorLike = Readonly<{
  execute: (
    actionId: ActionId,
    input: unknown,
    ctx: Readonly<{ defaultSessionId: string; surface: 'mcp' | 'cli' | 'agent' }>,
  ) => Promise<ActionExecutorResult>;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function createChangeTitleToolHandler(params: Readonly<{
  executor: ActionExecutorLike;
  surface: 'mcp' | 'cli' | 'agent';
  afterCommit?: (args: Readonly<{ sessionId: string; title: string }>) => Promise<void> | void;
}>): (sessionId: string, title: string) => Promise<unknown> {
  return async (sessionId: string, title: string) => {
    const normalizedSessionId = String(sessionId ?? '').trim();
    if (!normalizedSessionId) {
      return { success: false, error: 'session_not_selected' };
    }

    const res = await params.executor.execute(
      'session.title.set',
      { sessionId: normalizedSessionId, title },
      { surface: params.surface, defaultSessionId: normalizedSessionId },
    );

    if (!res.ok) {
      return { success: false, error: res.error };
    }

    const result = readRecord(res.result);
    if (result) {
      if (result.kind === 'approval_request_created') {
        return res.result;
      }
      if (result.ok === false) {
        const error = readNonEmptyString(result.error)
          ?? readNonEmptyString(result.errorCode)
          ?? 'action_failed';
        return { success: false, error };
      }
    }

    try {
      await Promise.resolve(params.afterCommit?.({ sessionId: normalizedSessionId, title }));
    } catch {
    }
    return { success: true, title };
  };
}
