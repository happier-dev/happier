import type { ActionExecutorContext } from './types.js';
import type { WorkflowTargetUnavailableReasonV1 } from '../../workflows/workflowProgressV1.js';

/** Host-only phases of the existing Session Action invocation; no input/content is captured. */
export type ActionStartPhaseV1 =
  | 'requester_runtime' | 'credentialed_factory' | 'machine_origin' | 'cli_context'
  | 'requester_projection' | 'agent_start_context' | 'caller_session' | 'role_overrides'
  | 'role_sources' | 'account_settings' | 'agent_inventory' | 'workflow_owner'
  | 'workflow_materialization_context' | 'workflow_workspace' | 'workflow_materialization';
export type ActionStartDiagnosticV1 = Readonly<{
  phase: ActionStartPhaseV1;
  elapsedMs?: number;
  refusalReason?: WorkflowTargetUnavailableReasonV1;
  requesterRuntimeBound?: boolean;
}>;

export async function measureActionStartPhaseV1<T>(context: ActionExecutorContext | undefined,
  phase: ActionStartPhaseV1, operation: () => Promise<T>): Promise<T> {
  if (!context?.recordActionStartDiagnostic) return await operation();
  const startedAt = Date.now();
  try { return await operation(); }
  finally { context?.recordActionStartDiagnostic?.({ phase, elapsedMs: Math.max(0, Date.now() - startedAt) }); }
}

export function actionStartTargetUnavailableV1(context: ActionExecutorContext | undefined,
  phase: ActionStartPhaseV1, reason: WorkflowTargetUnavailableReasonV1): Readonly<{
    ok: false; errorCode: 'target_unavailable'; error: 'target_unavailable';
    details: Readonly<{ code: 'target_unavailable'; reason: WorkflowTargetUnavailableReasonV1 }>;
  }> {
  context?.recordActionStartDiagnostic?.({ phase, refusalReason: reason });
  return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
    details: { code: 'target_unavailable', reason } };
}
