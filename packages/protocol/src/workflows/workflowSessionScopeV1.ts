import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionSessionAddressV1Schema } from '../actions/sessionTargetV1.js';
import { WorkflowInvocationRecordIdSchema } from './workflowIdsV1.js';

/** Host projection of one accepted invocation's Session authority, never authored Action input. */
export const WorkflowSessionScopeV1Schema = lazyZodSchema(() => z.strictObject({
  actionRequestId: z.string().check(z.minLength(1)),
  invocationId: WorkflowInvocationRecordIdSchema,
  sessions: z.array(ActionSessionAddressV1Schema),
}));
export type WorkflowSessionScopeV1 = z.infer<typeof WorkflowSessionScopeV1Schema>;

/** Shared correspondence for host-authored Action and Session invocation proofs. */
export function createWorkflowActionRequestIdV1(params: Readonly<{
  runId: string; logicalInvocationId: string; attempt: string | number;
}>): string {
  return `${params.runId}/${params.logicalInvocationId}/${params.attempt}`;
}

/** The coordinator's existing run/logical-invocation/attempt correspondence. */
export function readWorkflowActionInvocationV1(runId: string, actionRequestId: string | undefined):
  Readonly<{ logicalInvocationId: string; attempt: string }> | null {
  if (!actionRequestId) return null;
  const parts = actionRequestId.split('/');
  if (parts.length !== 3 || parts[0] !== runId || !/^(0|[1-9][0-9]*)$/.test(parts[2]!)) return null;
  const logical = WorkflowInvocationRecordIdSchema.safeParse(parts[1]);
  return logical.success ? { logicalInvocationId: logical.data, attempt: parts[2]! } : null;
}

/** Protocol admission and Home storage enforce this same exact invocation corpus. */
export function isWorkflowSessionScopeTargetV1(params: Readonly<{
  originSessionId?: string | null;
  scope?: Pick<WorkflowSessionScopeV1, 'sessions'>;
  sessionId?: string;
}>): boolean {
  return !!params.sessionId && (params.sessionId === params.originSessionId
    || params.scope?.sessions.some(address => address.sessionId === params.sessionId) === true);
}
