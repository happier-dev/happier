import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { z } from 'zod/mini';
import { z as mini } from 'zod/mini';
import { RuntimeActionIdV1Schema } from '@happier-dev/protocol/actions/actionIds';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createUnavailableRuntimeActionExecutor, resolveRuntimeActionExecutionFamily } from '@happier-dev/protocol/actions/executor/dispatch';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { RuntimeActionExecute } from '@happier-dev/protocol';

import { daemonPost } from '@/daemon/controlHttp';

export const BROWSER_RUNTIME_ACTION_CONTROL_PATH = '/browser/runtime-actions/execute';

/** Private host placement after Action admission; no caller-supplied policy context crosses IPC. */
export const BrowserRuntimeActionControlRequestSchema = z.strictObject({
  actionId: lazyZodSchema(() => RuntimeActionIdV1Schema.check(mini.refine((id) => ['browser', 'computer'].includes(resolveRuntimeActionExecutionFamily(id))))),
  input: StrictJsonValueSchema,
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  /** Authenticated host IPC carries Action-policy admission (approval, waiver or bypass), not caller authority. */
  approvalAdmitted: z.optional(z.literal(true)),
}).check(z.superRefine((request, ctx) => {
  if (!getActionSpec(request.actionId).inputSchema.safeParse(request.input).success) {
    ctx.addIssue({ code: "custom", path: ['input'], message: 'Invalid browser Action input' });
  }
}));

export const BrowserRuntimeActionControlResponseSchema = z.strictObject({
  result: StrictJsonValueSchema,
});

/** Session processes reach the daemon's current browser owner through its authenticated control transport. */
export function createCliBrowserRuntimeActionExecutor(params: Readonly<{ sessionId: string }>): RuntimeActionExecute {
  const unavailable = createUnavailableRuntimeActionExecutor();
  const fallbackSessionId = params.sessionId.trim();
  return async (args) => {
    if (args.context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const family = resolveRuntimeActionExecutionFamily(args.actionId);
    if (family !== 'browser' && family !== 'computer') return await unavailable(args);
    // Replay may be hosted by a global CLI executor. Keep the invoking Happier
    // Session separate from the Browser surface identity in semantic input.
    const sessionId = args.context.defaultSessionId?.trim() || fallbackSessionId;
    if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const response: unknown = await daemonPost(BROWSER_RUNTIME_ACTION_CONTROL_PATH, {
      actionId: args.actionId, input: args.input, sessionId,
      ...(args.context.bypassApprovals ? { approvalAdmitted: true } : {}),
    }, {
      timeoutMs: null,
      mutation: getActionSpec(args.actionId).sideEffectClass !== 'read',
      ...(args.context.signal ? { signal: args.context.signal } : {}),
    });
    const parsed = BrowserRuntimeActionControlResponseSchema.safeParse(response);
    if (parsed.success) return parsed.data.result;
    const errorCode = response && typeof response === 'object' && 'errorCode' in response
      ? response.errorCode : undefined;
    if (errorCode === 'cancelled' || errorCode === 'outcome_unknown') {
      return { ok: false, errorCode, error: errorCode };
    }
    return {
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_daemon_control_unavailable',
    };
  };
}
