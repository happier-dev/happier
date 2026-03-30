import type { ActionId } from '@happier-dev/protocol';

type ActionExecutorResult = Readonly<
  | { ok: true; result: unknown }
  | { ok: false; errorCode: string; error: string }
>;

type ActionExecutorLike = Readonly<{
  execute: (
    actionId: ActionId,
    input: unknown,
    ctx: Readonly<{ defaultSessionId: string; surface: 'mcp' | 'cli' | 'session_agent' }>,
  ) => Promise<ActionExecutorResult>;
}>;

export function createChangeTitleToolHandler(params: Readonly<{
  executor: ActionExecutorLike;
  surface: 'mcp' | 'cli' | 'session_agent';
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

    if (res.result && typeof res.result === 'object') {
      if ((res.result as any).kind === 'approval_request_created') {
        return res.result;
      }
      if ((res.result as any).ok === false) {
        const error = typeof (res.result as any).error === 'string' && (res.result as any).error.trim().length > 0
          ? (res.result as any).error
          : typeof (res.result as any).errorCode === 'string' && (res.result as any).errorCode.trim().length > 0
            ? (res.result as any).errorCode
            : 'action_failed';
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
