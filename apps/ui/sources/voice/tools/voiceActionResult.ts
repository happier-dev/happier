import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isSessionSpawnNewActionIdV1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { isRecord } from '@happier-dev/protocol/common/records';
import { normalizeSpawnSessionErrorDetail } from '@happier-dev/protocol/spawnSession';
import { SessionMessageReplyMutationResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { SessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { readSessionSpawnNewFailure, resolveSessionSpawnNewResultFailureMessage } from '@/sync/ops/actions/sessionSpawnFailurePresentation';
import type { VoiceSpawnAlternative } from './actionImpl/sessionSpawnAlternative';

export function jsonOk(payload?: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...(payload ?? {}) });
}

export function jsonError(errorCode: string, errorMessage?: string, payload?: Record<string, unknown>): string {
  return JSON.stringify({
    ok: false,
    errorCode,
    errorMessage: (errorMessage ?? errorCode) || 'unknown_error',
    ...(payload ?? {}),
  });
}

function jsonOkFromUnknown(value: unknown): string {
  if (isRecord(value)) {
    if (typeof value.ok === 'boolean') return JSON.stringify(value);
    return jsonOk(value);
  }
  return jsonOk({ result: value });
}

function getNestedActionFailure(actionId: ActionId, value: unknown): { errorCode: string; errorMessage: string; details?: unknown } | null {
  if (actionId === 'session.message.reply') {
    const reply = SessionMessageReplyMutationResultV1Schema.safeParse(value);
    if (reply.success && !reply.data.ok) {
      return { errorCode: reply.data.error, errorMessage: reply.data.error };
    }
  }
  const carrier = isRecord(value) ? value : {};
  if (carrier.success === false) {
    const errorCode = String(carrier.errorCode ?? carrier.code ?? 'unknown_error');
    return {
      errorCode,
      errorMessage: errorCode,
      ...(carrier.details === undefined ? {} : { details: carrier.details }),
    };
  }
  if (carrier.ok !== false) return null;
  return {
    errorCode: String(carrier.errorCode ?? 'unknown_error'),
    errorMessage: String(carrier.errorMessage ?? carrier.errorCode ?? 'unknown_error'),
    ...(carrier.details === undefined ? {} : { details: carrier.details }),
  };
}

/** Remove this serializer's spoken spawn context before the canonical Action wire check. */
export function projectVoiceActionExecutionResult(actionId: ActionId, value: unknown): unknown {
  if (!isSessionSpawnNewActionIdV1(actionId) || !isRecord(value)) return value;
  if (value.ok !== false && (value.ok !== true || !isRecord(value.result) || value.result.type !== 'error')) return value;
  const { agentTarget: _agentTarget, alternativeAgent: _alternativeAgent, errorMessage: _errorMessage, ...execution } = value;
  return execution;
}

export function serializeVoiceActionExecuteResult(
  actionId: ActionId,
  result: ActionExecuteResult,
  options?: Readonly<{
    failurePayload?: Record<string, unknown>;
    executedPayload?: Record<string, unknown>;
    canonicalResult?: boolean;
    agentTarget?: AgentExecutionTargetV1;
    alternativeAgent?: VoiceSpawnAlternative;
    spawnFailure?: Extract<SessionSpawnNewActionResultV1, { type: 'error' }> | null;
  }>,
): string {
  const spawnFailure = isSessionSpawnNewActionIdV1(actionId)
    ? options?.spawnFailure === undefined ? readSessionSpawnNewFailure(result) : options.spawnFailure
    : null;
  const alternative = options?.alternativeAgent;
  const spawnContext = spawnFailure ? {
    ...(options?.agentTarget ? { agentTarget: options.agentTarget } : {}),
    ...(alternative ? { alternativeAgent: alternative } : {}),
    errorMessage: `${options?.agentTarget ? `${options.agentTarget.identity.localId}: ` : ''}${resolveSessionSpawnNewResultFailureMessage(spawnFailure)}${
      alternative ? ` ${alternative.label} is ready on this Machine. Would you like to use ${alternative.label} instead?` : ''}`,
  } : undefined;
  if (options?.canonicalResult && !result.ok) return JSON.stringify({ ...result, ...spawnContext });
  if (!result.ok) {
    const details = isRecord(result.details) ? result.details : {};
    const errorDetail = normalizeSpawnSessionErrorDetail(details.errorDetail);
    return jsonError(result.errorCode, spawnContext?.errorMessage ?? (options?.agentTarget
      ? `${options.agentTarget.identity.localId}: ${result.errorCode}` : result.errorCode), {
      actionId,
      ...(result.failureCause ? { failureCause: result.failureCause } : {}),
      ...(result.details === undefined ? {} : { details: result.details }),
      ...(options?.agentTarget ? { agentTarget: options.agentTarget } : {}),
      ...spawnContext,
      // The Action-input owner has already projected these content-free repair facts.
      ...(typeof details.sessionId === 'string' ? { sessionId: details.sessionId } : {}),
      ...(errorDetail ? { errorDetail } : {}),
      ...(options?.failurePayload ?? {}),
    });
  }

  const domainResult = isRecord(result.result) ? result.result : {};
  if (spawnContext) {
    // The Action owner validated this settlement; presentation adds the bound
    // Agent without changing the domain result or inferring a startup cause.
    return options?.canonicalResult ? JSON.stringify({ ...result, ...spawnContext }) : jsonOk({ ...domainResult, ...spawnContext });
  }
  if (domainResult.ok === false && domainResult.status === 'partial') {
    return JSON.stringify(options?.canonicalResult ? result : domainResult);
  }

  const nestedFailure = getNestedActionFailure(actionId, result.result);
  if (nestedFailure) {
    if (options?.canonicalResult) return JSON.stringify({
      ok: false, errorCode: nestedFailure.errorCode, error: nestedFailure.errorMessage,
      ...(nestedFailure.details === undefined ? {} : { details: nestedFailure.details }),
    } satisfies ActionExecuteResult);
    return jsonError(nestedFailure.errorCode, nestedFailure.errorMessage, {
      actionId,
      ...(nestedFailure.details === undefined ? {} : { details: nestedFailure.details }),
      ...(options?.failurePayload ?? {}),
    });
  }

  if (options?.canonicalResult) return JSON.stringify(result);
  if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) {
    return jsonOkFromUnknown(result.result);
  }

  return options?.executedPayload
    ? jsonOk(options.executedPayload)
    : jsonOkFromUnknown(result.result);
}
