import { projectSessionRuntimeFailureCause, projectProviderSessionFailureCause, readProviderErrorDiagnosticFacts } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { asRecord, normalizeString } from './openCodeParsing.js';
import { formatOpenCodeServerPromptErrorMessage } from './formatOpenCodeServerPromptErrorMessage.js';
import { isOpenCodeServerAuthFailure } from './openCodeServerClient.js';
import type {
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  OpenCodeRuntimeEvent,
  OpenCodeRuntimeIssue,
  OpenCodeRuntimeScope,
} from './runtimeEvents.js';

export function projectOpenCodeTurnCancellationCause(
  reason: string | undefined,
): Extract<AgentSessionRuntimeEvent, { kind: 'turn-cancelled' }>['cause'] {
  return reason === 'host_shutdown'
    ? 'hostShutdown'
    : reason === 'session_dispose'
      ? 'sessionDispose'
      : reason === 'runtime_recovery'
        ? 'runtimeRecovery'
        : reason === 'user'
          ? 'user'
          : 'providerCancelled';
}

export function projectOpenCodeRuntimeScope(scope: OpenCodeRuntimeScope) {
  return scope.kind === 'session'
    ? { sessionId: scope.sessionId }
    : { executionRunId: scope.executionRunId };
}

export function buildOpenCodeRuntimeIssue(params: Readonly<{
  code: string;
  source: string;
  message?: string | null;
  occurredAt: number;
  usageLimit?: OpenCodeRuntimeIssue['usageLimit'];
  nativeProviderFailure?: OpenCodeRuntimeIssue['nativeProviderFailure'];
  failureCause?: OpenCodeRuntimeIssue['failureCause'];
}>): OpenCodeRuntimeIssue {
  return {
    v: 1,
    code: params.code,
    source: params.source,
    occurredAt: params.occurredAt,
    agentId: 'opencode',
    sanitizedPreview: params.message ?? null,
    ...(params.usageLimit ? { usageLimit: params.usageLimit } : {}),
    ...(params.nativeProviderFailure ? { nativeProviderFailure: params.nativeProviderFailure } : {}),
    ...(params.failureCause ? { failureCause: params.failureCause } : {}),
  };
}

function safeOpenCodeFailureCause(failureCause: OpenCodeRuntimeIssue['failureCause']) {
  if (!failureCause) return undefined;
  const { providerErrorMessage: _privateMessage, ...safeCause } = failureCause;
  return safeCause;
}

/** One diagnostic projection for Session and Execution Run input failures. */
export function createOpenCodeRuntimeDiagnostic(code: string, message?: string | null, error?: unknown) {
  const failureCause = safeOpenCodeFailureCause(projectSessionRuntimeFailureCause(error, 'turn_start', 'agent.turn'));
  return {
    code,
    severity: 'error' as const,
    ...(message ? { message } : {}),
    ...(failureCause ? { details: { failureCause } } : {}),
  };
}

/** Normalize native history, event and prompt failures before either runtime scope projects them. */
export function buildOpenCodeProviderErrorIssue(params: Readonly<{
  code: string;
  error: unknown;
  occurredAt: number;
  phase?: NonNullable<OpenCodeRuntimeIssue['failureCause']>['phase'];
  providerId?: string | null;
}>): OpenCodeRuntimeIssue {
  const record = asRecord(params.error);
  const data = asRecord(record?.data);
  const rawStatus = record?.status ?? data?.status ?? record?.statusCode ?? data?.statusCode;
  const status = typeof rawStatus === 'number' ? rawStatus : Number.parseInt(normalizeString(rawStatus), 10);
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  let body: unknown = data?.responseBody ?? record?.responseBodyPreview ?? record?.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const response = asRecord(body);
  const responseError = asRecord(response?.error);
  const vendorFacts = readProviderErrorDiagnosticFacts(response);
  const message = formatOpenCodeServerPromptErrorMessage(params.error);
  const nativeAuthEvidence = isOpenCodeServerAuthFailure(params.error) || record?.name === 'ProviderAuthError'
    ? 'Authentication failed' : '';
  const failureCause = safeOpenCodeFailureCause(projectProviderSessionFailureCause(params.error, params.phase ?? 'turn', {
    code: vendorFacts.code ?? normalizeString(record?.code ?? data?.code ?? response?.code ?? responseError?.type),
    httpStatus: httpStatus ?? vendorFacts.httpStatus,
    ...(typeof data?.isRetryable === 'boolean' ? { retryable: data.isRetryable } : {}),
    authenticationEvidence: [nativeAuthEvidence, record?.name, data?.name, data?.message, message]
      .map(normalizeString).join('\n'),
  }) ?? projectSessionRuntimeFailureCause(params.error, params.phase ?? 'turn', 'agent.turn'));
  const authFailure = failureCause?.failureReason === 'authentication_required'
    || failureCause?.code === 'client_attestation_denied';
  // Provider attribution retains the native wire evidence contract; generic host HTTP errors are separate.
  const nativeHttpStatus = typeof record?.type === 'string' ? record.status
    : record?.name === 'APIError' ? data?.statusCode : undefined;
  const nativeProviderFailure = params.providerId && typeof nativeHttpStatus === 'number'
    && Number.isInteger(nativeHttpStatus) && nativeHttpStatus >= 100 && nativeHttpStatus <= 599
    ? { providerId: params.providerId, httpStatus: nativeHttpStatus } : null;
  return buildOpenCodeRuntimeIssue({
    code: params.code,
    source: authFailure ? 'auth_error' : 'agent_session_error',
    message,
    occurredAt: params.occurredAt,
    ...(nativeProviderFailure ? { nativeProviderFailure } : {}),
    ...(failureCause ? { failureCause } : {}),
  });
}

/** Both native scopes preserve the same normalized provider evidence. */
export function projectOpenCodeRuntimeIssueDiagnostic(issue: OpenCodeRuntimeIssue) {
  return {
    code: issue.code,
    severity: 'error' as const,
    ...(issue.sanitizedPreview ? { message: issue.sanitizedPreview } : {}),
    details: {
      v: issue.v,
      source: issue.source,
      agentId: issue.agentId,
      ...(issue.usageLimit ? { usageLimit: issue.usageLimit } : {}),
      ...(issue.nativeProviderFailure ? { nativeProviderFailure: issue.nativeProviderFailure } : {}),
      ...(issue.failureCause ? { failureCause: issue.failureCause } : {}),
    },
  };
}

export async function publishOpenCodeRuntimeEvent(
  publishRuntimeEvent: (event: OpenCodeRuntimeEvent) => void,
  event: OpenCodeRuntimeEvent,
): Promise<void> {
  publishRuntimeEvent(event);
}

export async function publishOpenCodeTurnFailed(params: Readonly<{
  publishRuntimeEvent: (event: OpenCodeRuntimeEvent) => void;
  scope: OpenCodeRuntimeScope;
  turnId: string;
  issue: OpenCodeRuntimeIssue;
  emittedAtMs: number;
}>): Promise<void> {
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'turn-failed',
    ...projectOpenCodeRuntimeScope(params.scope),
    turnId: params.turnId,
    emittedAtMs: params.emittedAtMs,
    issue: params.issue,
  });
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'transcript-agent-message-committed',
    ...projectOpenCodeRuntimeScope(params.scope),
    emittedAtMs: params.emittedAtMs,
    agentId: 'opencode',
    localId: `${params.turnId}:turn_failed`,
    body: {
      type: 'turn_failed',
      id: params.turnId,
    },
  });
}

export async function publishOpenCodeTurnCancelled(params: Readonly<{
  publishRuntimeEvent: (event: OpenCodeRuntimeEvent) => void;
  scope: OpenCodeRuntimeScope;
  turnId: string;
  reason?: string;
  emittedAtMs: number;
}>): Promise<void> {
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'turn-cancelled',
    ...projectOpenCodeRuntimeScope(params.scope),
    turnId: params.turnId,
    emittedAtMs: params.emittedAtMs,
    ...(params.reason ? { reason: params.reason } : {}),
  });
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'transcript-agent-message-committed',
    ...projectOpenCodeRuntimeScope(params.scope),
    emittedAtMs: params.emittedAtMs,
    agentId: 'opencode',
    localId: `${params.turnId}:turn_cancelled`,
    body: {
      type: 'turn_cancelled',
      id: params.turnId,
    },
  });
}
