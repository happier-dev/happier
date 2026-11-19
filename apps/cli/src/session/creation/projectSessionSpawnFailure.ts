import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { isConnectedServiceResumeUnreachableSpawnErrorDetail, isConnectedServiceUxDiagnosticSpawnErrorDetail, normalizeSpawnSessionErrorDetail, SessionCreationTerminalSpawnErrorDetailSchema, SessionSpawnLaunchErrorV1Schema, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import type { SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { readSessionPreparationFailureCode, readSessionStartupFailurePreview } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { resolveAgentDisplayTitle } from '@/agent/catalog/agentDisplayTitle';
import { sanitizeConnectedServiceDiagnosticString } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { ProviderErrorCodeV1Schema, createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { readTeamCredentialLaunchFailureCode } from '@/session/services/sessionTeamCredentialLaunchError';
import type { SpawnFailureV1 } from '@happier-dev/protocol';

/** The creation adapter retains the daemon's redacted cause, not just its outcome. */
export function projectSessionSpawnFailure(input: Readonly<{
  errorCode: string;
  errorMessage: unknown;
  agentId?: unknown;
  errorDetail?: unknown;
  requestId?: string;
}>): Extract<SessionSpawnNewResultV1, { type: 'error' }> {
  const normalized = normalizeSpawnSessionNonceResolution({ status: 'error', ...input });
  const creationFailure = SessionCreationTerminalSpawnErrorDetailSchema.safeParse(input.errorDetail);
  if (creationFailure.success && creationFailure.data.kind === 'session_creation_currentness_unavailable') {
    const { kind: _kind, code, ...currentnessFailure } = creationFailure.data;
    return { type: 'error', code: 'spawn_failed', retryable: currentnessFailure.retryable,
      launchError: { kind: 'launch_error', code,
        message: typeof input.errorMessage === 'string' && input.errorMessage.trim()
          ? sanitizeConnectedServiceDiagnosticString(input.errorMessage)
          : 'Account encryption currentness is unavailable', currentnessFailure } };
  }
  if (isConnectedServiceUxDiagnosticSpawnErrorDetail(input.errorDetail)
    || isConnectedServiceResumeUnreachableSpawnErrorDetail(input.errorDetail)) {
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
        failureCause: { phase: 'authentication' as const,
          failureReason: 'authentication_required' as const,
          ...(input.requestId ? { requestId: input.requestId } : {}) },
      } } : {}),
    };
  }
  const nativeFailure = normalizeSpawnSessionErrorDetail(input.errorDetail);
  if (nativeFailure?.kind === 'provider_error') {
    const { providerError } = nativeFailure;
    return { type: 'error', code: 'spawn_failed', retryable: providerError.retryable,
      providerError,
      launchError: { kind: 'launch_error', code: providerError.code, message: providerError.code } };
  }
  const detail = SessionSpawnLaunchErrorV1Schema.safeParse(input.errorDetail);
  const nativeCode = nativeFailure?.kind === 'spawn_failure' ? nativeFailure.errno : undefined;
  let spawnFailure: SpawnFailureV1 | undefined;
  if (nativeFailure?.kind === 'spawn_failure') {
    const { kind: _kind, ...cause } = nativeFailure;
    spawnFailure = cause;
  }
  // executeSpawnSessionRequest and launch-witness admission carry closed
  // preflight codes in the validation message. Preserve that exact code;
  // arbitrary daemon prose cannot become a public failure classification.
  const preparationCode = input.errorCode === SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED
    ? readTeamCredentialLaunchFailureCode(input.errorMessage) ?? readSessionPreparationFailureCode(input.errorMessage)
      ?? (input.errorMessage === 'team_credential_provider_binding_unavailable' ? input.errorMessage : null)
    : null;
  const fallback = SessionSpawnLaunchErrorV1Schema.safeParse({ kind: 'launch_error',
    code: input.errorCode === SPAWN_SESSION_ERROR_CODES.SPAWN_NO_PID ? input.errorCode
      : nativeCode ?? preparationCode ?? (input.errorCode || SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED),
    ...(spawnFailure ? { spawnFailure } : {}),
    message: typeof input.errorMessage === 'string' && input.errorMessage.trim()
      ? input.errorMessage : 'Session launch failed' });
  const causeCode = detail.success ? detail.data.failureCause?.code : undefined;
  const typedCauseCode = readTeamCredentialLaunchFailureCode(causeCode)
    ?? (readSessionStartupFailurePreview(causeCode) ? causeCode : undefined);
  const code = typedCauseCode ?? (detail.success ? detail.data.code : nativeCode ?? preparationCode ?? input.errorCode);
  const modelSelectionRequired = code === 'agent_startup_model_reconciliation_failed'
    && detail.success && detail.data.failureCause?.failureReason === 'model_selection_required';
  if (code === 'agent_cli_not_runnable') {
    const title = typeof input.agentId === 'string' ? resolveAgentDisplayTitle(input.agentId) : null;
    return { type: 'error', code: 'spawn_failed', retryable: false,
      launchError: { kind: 'launch_error', code, message: readSessionStartupFailurePreview(code, title)!,
        ...(detail.success && detail.data.failureCause ? { failureCause: detail.data.failureCause } : {}) } };
  }
  const providerCode = ProviderErrorCodeV1Schema.safeParse(code);
  const retryable = (detail.success ? detail.data.failureCause?.retryable : undefined) ?? (modelSelectionRequired || code === 'profile_launch_unavailable' || code === 'update_required' || code === 'team_credential_model_selection_required'
    || code === 'agent_isolation_unavailable' || code === 'plugin_code_unreadable' || code === 'SOURCE_RUNTIME_RELOAD_REQUIRED'
    || code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired ? false
    : providerCode.success ? createProviderErrorV1(providerCode.data).retryable : true);
  return { type: 'error', code: 'spawn_failed', retryable,
    launchError: detail.success ? { ...detail.data, code: typedCauseCode ?? detail.data.code,
      ...(modelSelectionRequired ? { message: readSessionStartupFailurePreview(code, null, detail.data.failureCause)! } : {}) } : fallback.success ? fallback.data
      : { kind: 'launch_error', code: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, message: 'Session launch failed' } };
}
