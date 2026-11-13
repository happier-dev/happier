import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import type { ActionExecuteResult } from './actionExecutionResult.js';

/** Refusing owners publish names only, never input, identities, paths or secrets. */
export const ActionRefusalDiagnosticV1Schema = lazyZodSchema(() => z.strictObject({ reason: z.enum([
  'authority_path_absent', 'turn_witness_absent', 'execution_run_turn_mismatch', 'execution_run_not_current',
  'scm_workspace_invalid', 'turn_witness_projection_invalid', 'runner_authority_refused', 'native_realtime_caller_invalid',
  'own_reachable_machine_absent', 'plugin_action_declaration_absent', 'plugin_options_declaration_absent',
  'explicit_machine_target_absent', 'session_transport_absent', 'session_machine_absent', 'caller_fallback_unsupported',
  'channels_result_invalid', 'channels_session_mismatch', 'channels_operation_mismatch',
  'session_absent', 'capability_identity_unresolved',
]) }));
export type ActionRefusalReasonV1 = z.infer<typeof ActionRefusalDiagnosticV1Schema>['reason'];

export function createActionRefusalDetailsV1<C extends 'target_unavailable' | 'not_found'>(code: C, reason: ActionRefusalReasonV1) {
  return { code, diagnostic: { reason } } as const;
}

export function actionTargetUnavailable(reason: ActionRefusalReasonV1) {
  return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
    details: createActionRefusalDetailsV1('target_unavailable', reason) } as const satisfies ActionExecuteResult;
}
