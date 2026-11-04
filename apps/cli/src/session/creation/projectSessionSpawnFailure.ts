import { readSessionStartupFailurePreview } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { resolveAgentDisplayTitle } from '@/agent/catalog/agentDisplayTitle';
import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { isConnectedServiceUxDiagnosticSpawnErrorDetail, SessionSpawnLaunchErrorV1Schema, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import type { SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { sanitizeConnectedServiceDiagnosticString } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';

/** The creation adapter retains the daemon's redacted cause, not just its outcome. */
export function projectSessionSpawnFailure(input: Readonly<{
  errorCode: string;
  errorMessage: unknown;
  agentId?: unknown;
  errorDetail?: unknown;
}>): Extract<SessionSpawnNewResultV1, { type: 'error' }> {
  const normalized = normalizeSpawnSessionNonceResolution({ status: 'error', ...input });
  if (isConnectedServiceUxDiagnosticSpawnErrorDetail(input.errorDetail)) {
    const diagnostic = input.errorDetail.uxDiagnostic;
    const reason = diagnostic.diagnostics?.reason;
    const cause = typeof reason === 'string' && reason !== 'spawn_preflight' && reason !== 'profile_action_required'
      ? sanitizeConnectedServiceDiagnosticString(reason) : '';
    return { type: 'error', code: 'spawn_failed', retryable: diagnostic.retryable,
      launchError: { kind: 'launch_error', code: diagnostic.code,
        uxDiagnostic: diagnostic,
        message: diagnostic.code === 'connected_service_credential_reconnect_required'
          ? 'Reconnect the selected Connected Account profile, then retry.'
          : `The selected Connected Account could not be prepared.${cause ? ` Reason: ${cause}.` : ''} Review Connected Accounts, then retry.` } };
  }
  if (normalized.status === 'error' && normalized.agentId
    && (normalized.errorCode === SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING
      || normalized.errorCode === SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT)) {
    return { type: 'error', code: normalized.errorCode, agentId: normalized.agentId, retryable: false,
      ...(normalized.errorCode === SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT ? { launchError: {
        kind: 'launch_error' as const, code: normalized.errorCode,
        message: 'Sign in to the Agent on the target Machine. If using Connected Accounts, select a Connected Account profile for this Session or recipe, or configure an Account default profile before retrying.',
      } } : {}),
    };
  }
  const detail = SessionSpawnLaunchErrorV1Schema.safeParse(input.errorDetail);
  const code = detail.success ? detail.data.code
    : input.errorCode === SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED && input.errorMessage === 'agent_cli_not_runnable'
      ? 'agent_cli_not_runnable' : input.errorCode;
  if (code === 'agent_cli_not_runnable') {
    const title = typeof input.agentId === 'string' ? resolveAgentDisplayTitle(input.agentId) : null;
    return { type: 'error', code: 'spawn_failed', retryable: false,
      launchError: { kind: 'launch_error', code, message: readSessionStartupFailurePreview(code, title)!,
        ...(detail.success && detail.data.failureCause ? { failureCause: detail.data.failureCause } : {}) } };
  }
  const fallback = SessionSpawnLaunchErrorV1Schema.safeParse({ kind: 'launch_error',
    code: input.errorCode || SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
    message: typeof input.errorMessage === 'string' && input.errorMessage.trim()
      ? input.errorMessage : 'Session launch failed' });
  return { type: 'error', code: 'spawn_failed', retryable: true,
    launchError: detail.success ? detail.data : fallback.success ? fallback.data
      : { kind: 'launch_error', code: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, message: 'Session launch failed' } };
}
