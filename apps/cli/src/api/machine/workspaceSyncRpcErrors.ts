import { ActionFailureCauseV1Schema, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { logger } from '@/ui/logger';

// Workspace Sync has no Protocol error-code schema: its transported RPCs are
// private adapters. Keep promotion closed here so Node/fs codes never become
// caller-visible protocol identity merely because they use `error.code`.
const WORKSPACE_SYNC_RPC_ERROR_CODES: ReadonlySet<string> = new Set([
  'agent_unavailable',
  'approval_stale',
  'approval_required',
  'bootstrap_definition_conflict',
  'cancelled',
  'conflict_changed',
  'conflict_resolution_unsupported',
  'controller_unavailable',
  'engine_unavailable',
  'forbidden',
  'git_selection_unavailable',
  'indeterminate',
  'invalid_request',
  'machine_carrier_unavailable',
  'machine_manage_required',
  'peer_unavailable',
  'project_requester_authority_unavailable',
  'relationship_definition_conflict',
  'relationship_not_owned',
  'relationship_not_ready',
  'relationship_replacement_required',
  'relationship_runtime_mismatch',
  'root_changed',
  'root_mismatch',
  'target_bootstrap_offline',
  'target_bootstrap_required',
  'target_unavailable',
  'workspace_file_unsupported',
  'workspace_machine_not_enrolled',
  'workspace_ref_not_ready',
  'workspace_root_identity_unavailable',
  'workspace_root_in_use',
  'workspace_root_ownership_compromised',
  'workspace_root_ownership_lost',
  'workspace_root_unsafe',
  'workspace_sync_controller_mismatch',
  'workspace_sync_child_unavailable',
  'workspace_sync_settings_conflict',
  'workspace_sync_settings_invalid',
  'workspace_sync_settings_unavailable',
  'workspace_sync_unavailable',
  'workspace_sync_update_required',
  'workspace_sync_operation_conflict',
  'workspace_sync_recovery_needed',
  'workspace_sync_prepare_missing',
  'workspace_sync_finalize_missing',
  'workspace_write_denied',
  'workspace_write_escalation_denied',
  'present_user_required',
  'workspace_copy_not_owned',
  'workspace_copy_preview_unavailable',
  'workspace_copy_removal_unavailable',
  'workspace_copy_removal_unknown',
  'workspace_sync_relationship_in_use',
  'workspace_sync_dependencies_unavailable',
  'workspace_target_materialization_manual_recovery',
] as const);

type WorkspaceSyncRpcFailureCause = Readonly<{
  code: string | null;
  name: string;
  message: string;
}>;

function projectAggregateCauses(error: AggregateError): WorkspaceSyncRpcFailureCause[] {
  return error.errors.map((value: unknown) => {
    const code = value instanceof Error && 'code' in value && typeof value.code === 'string'
      ? value.code : readRpcErrorCode(value);
    return {
      code: code ? redactBugReportSensitiveText(code) : null,
      name: redactBugReportSensitiveText(value instanceof Error ? value.name : 'UnknownThrownValue'),
      message: redactBugReportSensitiveText(value instanceof Error ? value.message : 'Unknown Workspace Sync error'),
    };
  });
}

export function projectWorkspaceSyncRpcError(error: unknown, method: string, requestId?: string): unknown {
  if (readRpcErrorCode(error) !== undefined) return error;
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
    && WORKSPACE_SYNC_RPC_ERROR_CODES.has(error.code) ? error.code : undefined;
  if (code !== undefined || method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE) {
    // Preserve the producer's closed cause, including a transported TARGET phase.
    const carried = ActionFailureCauseV1Schema.safeParse(error instanceof Error
      ? ('failureCause' in error ? error.failureCause : undefined)
        ?? (error.cause && typeof error.cause === 'object' && 'failureCause' in error.cause ? error.cause.failureCause : undefined)
      : undefined);
    if (method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE) {
      // Only this owner's admitted RPC vocabulary is an authored diagnostic code.
      // OS/native details remain redacted diagnostics, never new protocol identity.
      const projectedDiagnostic = carried.success ? carried.data
        : projectActionFailureCauseV1(error, undefined, { allowUnknownErrorCode: code !== undefined });
      const diagnostic = projectedDiagnostic.errorCode === null && code !== undefined
        ? { ...projectedDiagnostic, errorCode: code } : projectedDiagnostic;
      const cause: WorkspaceSyncRpcFailureCause = {
        code: diagnostic.errorCode === null ? null : redactBugReportSensitiveText(diagnostic.errorCode),
        name: redactBugReportSensitiveText(error instanceof Error ? error.name : 'UnknownThrownValue'),
        message: redactBugReportSensitiveText(error instanceof Error ? error.message
          : typeof error === 'string' ? error : 'Unknown Workspace Sync error'),
      };
      const failureCause = { ...diagnostic, errorCode: cause.code };
      const projected = Object.assign(new RpcError(code === undefined || code === 'machine_manage_required'
        ? `Workspace linking could not complete. ${cause.name}${cause.code ? ` (${cause.code})` : ''}: ${cause.message}`
        : cause.message, code === undefined || code === 'machine_manage_required' ? 'workspace_sync_unavailable' : code, failureCause),
      { ...(code === undefined || code === 'machine_manage_required' ? {} : { code }), cause, failureCause });
      logger.warnLocalFile('[Workspace Sync] Relationship create failed', {
        method, requestId, cause, failureCause,
        ...(error instanceof AggregateError ? { errors: projectAggregateCauses(error) } : {}),
      });
      return projected;
    }
    if (code !== undefined && error instanceof Error) {
      return Object.assign(new RpcError(redactBugReportSensitiveText(error.message), code, carried.success ? carried.data : undefined),
        { code, cause: error });
    }
  }
  return error;
}
