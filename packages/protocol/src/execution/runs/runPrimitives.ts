import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { NativePermissionChoicesV1Schema } from '../../sessions/permissions/nativeChoicesV1.js';

/** Display-only proof of supported instruction delivery; Home is the portable identity. */
export const ExecutionRunPreparedInstructionsForSchema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.minLength(1)),
  sessionId: z.string().check(z.minLength(1)),
}));

export const ExecutionRunPermissionRequestIdentitySchema = lazyZodSchema(() => z.strictObject({
  requestId: z.string().check(z.minLength(1)), createdAt: z.number().check(z.int(), z.nonnegative()),
  nativeChoices: z.optional(z.nullable(NativePermissionChoicesV1Schema)),
}));

export const ExecutionRunIntentSchema = lazyZodSchema(() => z.enum([
  'review',
  'plan',
  'delegate',
  'agent',
  'task',
  'voice_agent',
  'memory_hints',
  'scm_commit_message',
  'scm_diff_summary',
]));
export type ExecutionRunIntent = z.infer<typeof ExecutionRunIntentSchema>;

export const ExecutionRunRetentionPolicySchema = lazyZodSchema(() => z.enum(['ephemeral', 'resumable']));
export type ExecutionRunRetentionPolicy = z.infer<typeof ExecutionRunRetentionPolicySchema>;

export const ExecutionRunClassSchema = lazyZodSchema(() => z.enum(['bounded', 'long_lived']));
export type ExecutionRunClass = z.infer<typeof ExecutionRunClassSchema>;

export const ExecutionRunIoModeSchema = lazyZodSchema(() => z.enum(['request_response', 'streaming']));
export type ExecutionRunIoMode = z.infer<typeof ExecutionRunIoModeSchema>;

// Canonical, stable error code vocabulary for RPC `errorCode` and MCP `error.code`.
// Keep this pinned and deterministic; clients should branch on these strings.
export const ExecutionRunTransportErrorCodeSchema = lazyZodSchema(() => z.enum([
  'execution_run_not_allowed',
  'execution_run_input_required',
  'execution_run_not_found',
  'execution_run_action_not_supported',
  'execution_run_invalid_action_input',
  'execution_run_stream_not_found',
  'execution_run_busy',
  'execution_run_send_outcome_unknown',
  'execution_run_failed',
  'execution_run_budget_exceeded',
  'execution_run_output_limit_exceeded',
  'execution_run_protocol_unsupported',
  'execution_run_target_not_selected',
  'execution_run_target_unavailable',
  'execution_run_child_choice_required',
  'execution_run_child_default_unavailable',
  'execution_run_parent_selection_unavailable',
  'execution_run_start_ambiguous',
  'execution_run_scope_mismatch',
  'execution_run_connected_service_generation_refresh_required',
  'permission_denied',
]));
export type ExecutionRunTransportErrorCode = z.infer<typeof ExecutionRunTransportErrorCodeSchema>;

/** Session prompt identity preserves the Run and the controller occurrence that owns the answer. */
export function buildRunScopedExecutionPermissionRequestId(params: Readonly<{
  runId: string;
  controllerOccurrenceId: string;
  providerRequestId: string;
}>): string {
  const runId = String(params.runId ?? '').trim();
  const controllerOccurrenceId = String(params.controllerOccurrenceId ?? '').trim();
  if (!runId || !controllerOccurrenceId) {
    throw new Error('Execution-run permission request identity requires run and controller occurrence ids');
  }
  return `execution-run:${encodeURIComponent(runId)}:${encodeURIComponent(controllerOccurrenceId)}:${encodeURIComponent(params.providerRequestId)}`;
}

export function readRunScopedExecutionPermissionRequestIdentity(requestId: string): Readonly<{
  runId: string;
  controllerOccurrenceId: string;
  providerRequestId: string;
}> | null {
  const parts = requestId.split(':');
  if (parts.length !== 4 || parts[0] !== 'execution-run') return null;
  try {
    const runId = decodeURIComponent(parts[1]!);
    const controllerOccurrenceId = decodeURIComponent(parts[2]!);
    if (!runId.trim() || !controllerOccurrenceId.trim()) return null;
    return { runId, controllerOccurrenceId, providerRequestId: decodeURIComponent(parts[3]!) };
  } catch {
    return null;
  }
}

// Action inputs share this request without importing Voice-dependent stream events.
export const ExecutionRunTurnStreamReadRequestSchema = lazyZodSchema(() => z.looseObject({
  runId: z.string().check(z.minLength(1)),
  streamId: z.string().check(z.minLength(1)),
  cursor: z.number().check(z.int(), z.minimum(0)),
  maxEvents: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(256))),
  /** Hold an empty read until this cursor has events or the stream becomes terminal. */
  waitForEvents: z.optional(z.boolean()),
}));
export type ExecutionRunTurnStreamReadRequest = z.infer<typeof ExecutionRunTurnStreamReadRequestSchema>;
export const ExecutionRunAttentionKindSchema = lazyZodSchema(() => z.enum(['permission_required', 'user_action_required']));

export function readExecutionRunAttentionRequestIds(attention: Readonly<{
  kind: z.infer<typeof ExecutionRunAttentionKindSchema>;
  requestIds: readonly string[];
  questionRequestIds?: readonly string[];
}> | undefined, type: 'approval' | 'decision'): readonly string[] {
  if (!attention) return [];
  if (attention.kind === 'user_action_required') return type === 'decision' ? attention.requestIds : [];
  if (type === 'decision') return attention.questionRequestIds ?? [];
  return attention.questionRequestIds ? attention.requestIds.filter(id => !attention.questionRequestIds?.includes(id)) : attention.requestIds;
}
