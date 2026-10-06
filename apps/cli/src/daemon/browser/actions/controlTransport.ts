import { z } from 'zod';
import { RuntimeActionIdV1Schema } from '@happier-dev/protocol/actions/actionIds';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createUnavailableRuntimeActionExecutor, resolveRuntimeActionExecutionFamily } from '@happier-dev/protocol/actions/executor/dispatch';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { RuntimeActionExecute } from '@happier-dev/protocol';

import { daemonPost } from '@/daemon/controlHttp';

export const BROWSER_RUNTIME_ACTION_CONTROL_PATH = '/browser/runtime-actions/execute';

/** Private host placement after Action admission; no caller-supplied policy context crosses IPC. */
export const BrowserRuntimeActionControlRequestSchema = z.object({
  actionId: RuntimeActionIdV1Schema.refine((id) => ['browser', 'computer'].includes(resolveRuntimeActionExecutionFamily(id))),
  input: StrictJsonValueSchema,
  sessionId: z.string().trim().min(1),
  /** Authenticated host IPC carries Action-policy admission (approval, waiver or bypass), not caller authority. */
  approvalAdmitted: z.literal(true).optional(),
}).strict().superRefine((request, ctx) => {
  if (!getActionSpec(request.actionId).inputSchema.safeParse(request.input).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['input'], message: 'Invalid browser Action input' });
  }
});

export const BrowserRuntimeActionControlResponseSchema = z.object({
  result: StrictJsonValueSchema,
}).strict();

/** Session processes reach the daemon's current browser owner through its authenticated control transport. */
export function createCliBrowserRuntimeActionExecutor(params: Readonly<{ sessionId: string }>): RuntimeActionExecute {
  const unavailable = createUnavailableRuntimeActionExecutor();
  const sessionId = params.sessionId.trim();
  return async (args) => {
    args.context.signal?.throwIfAborted();
    const family = resolveRuntimeActionExecutionFamily(args.actionId);
    if (family !== 'browser' && family !== 'computer') return await unavailable(args);
    if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const response: unknown = await daemonPost(BROWSER_RUNTIME_ACTION_CONTROL_PATH, {
      actionId: args.actionId, input: args.input, sessionId,
      ...(args.context.bypassApprovals ? { approvalAdmitted: true } : {}),
    }, {
      timeoutMs: null,
      ...(args.context.signal ? { signal: args.context.signal } : {}),
    });
    args.context.signal?.throwIfAborted();
    const parsed = BrowserRuntimeActionControlResponseSchema.safeParse(response);
    return parsed.success ? parsed.data.result : {
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_daemon_control_unavailable',
    };
  };
}
