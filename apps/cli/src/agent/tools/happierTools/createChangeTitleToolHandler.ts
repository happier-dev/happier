import type { ActionId, ApprovalRequestOriginV1 } from '@happier-dev/protocol';
import type { ActionToolExecutionOptions } from './createActionToolExecutorBridge';

type ActionExecutorResult = Readonly<
  | { ok: true; result: unknown }
  | { ok: false; errorCode: string; error: string }
>;

type ActionExecutorLike = Readonly<{
  execute: (
    actionId: ActionId,
    input: unknown,
    ctx: Readonly<{
      defaultSessionId: string;
      surface: import('./actionToolCatalog').HappierBuiltInToolSurface;
      approvalOrigin?: ApprovalRequestOriginV1 | null;
      callerPermissionMode?: string | null;
      actionRequestId?: string | null;
      signal?: AbortSignal;
    }>,
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
  surface: import('./actionToolCatalog').HappierBuiltInToolSurface;
  resolveCallerPermissionMode?: (() => string | null | undefined) | null;
  afterCommit?: (args: Readonly<{ sessionId: string; title: string }>) => Promise<void> | void;
}>): (sessionId: string, title: string, options?: Pick<ActionToolExecutionOptions, 'approvalOrigin' | 'actionRequestId' | 'signal'>) => Promise<unknown> {
  return async (sessionId, title, options) => {
    const normalizedSessionId = String(sessionId ?? '').trim();
    if (!normalizedSessionId) {
      return { success: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
    }

    const approvalOrigin = options?.approvalOrigin ?? null;
    const callerPermissionMode = params.resolveCallerPermissionMode?.() ?? null;
    const actionRequestId = options?.actionRequestId ?? approvalOrigin?.toolCallId
      ?? approvalOrigin?.mcpRequestId
      ?? approvalOrigin?.messageId
      ?? approvalOrigin?.parentMessageId
      ?? null;
    const res = await params.executor.execute(
      'session.title.set',
      { sessionId: normalizedSessionId, title },
      {
        surface: params.surface,
        defaultSessionId: normalizedSessionId,
        ...(approvalOrigin ? { approvalOrigin } : {}),
        ...(callerPermissionMode ? { callerPermissionMode } : {}),
        ...(actionRequestId ? { actionRequestId } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );

    if (!res.ok) {
      return { success: false, errorCode: res.errorCode, error: res.error };
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
        return { success: false, errorCode: readNonEmptyString(result.errorCode) ?? 'action_failed', error };
      }
    }

    try {
      await Promise.resolve(params.afterCommit?.({ sessionId: normalizedSessionId, title }));
    } catch {
    }
    return { success: true, title };
  };
}
