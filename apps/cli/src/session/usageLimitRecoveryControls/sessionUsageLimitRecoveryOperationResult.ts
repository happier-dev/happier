import {
  SessionUsageLimitRecoveryOperationResultV1Schema,
  normalizeSessionUsageLimitRecoveryOperationResultV1,
  type SessionUsageLimitRecoveryOperationResultV1,
} from '@happier-dev/protocol';

type NormalizeCliSessionUsageLimitRecoveryOperationResultParams = Readonly<{
  sessionId: string;
  result: unknown;
}>;

export type ExplicitUserPromptRecoveryDecision =
  | Readonly<{ status: 'ready' }>
  | Readonly<{
      status: 'waiting' | 'action_required' | 'unavailable';
      errorCode: string;
    }>;

export function normalizeCliSessionUsageLimitRecoveryOperationResult(
  params: NormalizeCliSessionUsageLimitRecoveryOperationResultParams,
): SessionUsageLimitRecoveryOperationResultV1 {
  const normalized = normalizeSessionUsageLimitRecoveryOperationResultV1(params.result, {
    sessionId: params.sessionId,
  });

  if (normalized.ok) {
    return SessionUsageLimitRecoveryOperationResultV1Schema.parse(normalized);
  }

  return SessionUsageLimitRecoveryOperationResultV1Schema.parse({
    ...normalized,
    sessionId: normalized.sessionId ?? params.sessionId,
  });
}

export function resolveExplicitUserPromptRecoveryDecision(params: Readonly<{
  sessionId: string;
  result: unknown;
  hasBlockingRecoveryEvidence: boolean;
}>): ExplicitUserPromptRecoveryDecision {
  const normalized = normalizeCliSessionUsageLimitRecoveryOperationResult({
    sessionId: params.sessionId,
    result: params.result,
  });

  if (normalized.ok) {
    if (normalized.status === 'waiting') {
      return { status: 'waiting', errorCode: 'session_user_message_recovery_pending' };
    }
    if (
      normalized.status === 'ready'
      || normalized.status === 'resumed'
      || normalized.status === 'cancelled'
      || normalized.status === 'already_ready'
      || normalized.status === 'no_recovery_needed'
    ) {
      return { status: 'ready' };
    }
    return {
      status: 'action_required',
      errorCode: 'session_user_message_recovery_action_required',
    };
  }

  const recoveryIsAbsent = normalized.status === 'inactive'
    || normalized.errorCode === 'unsupported_session_runtime_method';
  if (recoveryIsAbsent && !params.hasBlockingRecoveryEvidence) {
    return { status: 'ready' };
  }

  if (normalized.status === 'malformed_response' || normalized.status === 'session_unreachable') {
    return {
      status: 'unavailable',
      errorCode: normalized.errorCode,
    };
  }

  return {
    status: 'action_required',
    errorCode: normalized.errorCode,
  };
}

export function attachCliSessionUsageLimitRecoveryOperationMetadata<T extends SessionUsageLimitRecoveryOperationResultV1>(
  result: T,
  metadata: Record<string, unknown> | null | undefined,
): T {
  if (!metadata) return result;
  // RD-REC-17: metadata is part of the typed contract (optional field), so it must
  // be a plain enumerable property that survives validation and serialization.
  return { ...result, metadata };
}
