import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isSessionSpawnNewActionIdV1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { isRecord } from '@happier-dev/protocol/common/records';
import { normalizeSpawnSessionErrorDetail } from '@happier-dev/protocol/spawnSession';
import { SessionMessageReplyMutationResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { SessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { resolveSessionSpawnNewResultFailureMessage } from '@/sync/ops/actions/sessionSpawnFailurePresentation';
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

export function serializeVoiceActionExecuteResult(
  actionId: ActionId,
  result: ActionExecuteResult,
  options?: Readonly<{
    failurePayload?: Record<string, unknown>;
    executedPayload?: Record<string, unknown>;
    canonicalResult?: boolean;
    agentTarget?: AgentExecutionTargetV1;
    alternativeAgent?: VoiceSpawnAlternative;
  }>,
): string {
  if (options?.canonicalResult && !result.ok) return JSON.stringify(result);
  if (!result.ok) {
    const details = isRecord(result.details) ? result.details : {};
    const errorDetail = normalizeSpawnSessionErrorDetail(details.errorDetail);
    return jsonError(result.errorCode, options?.agentTarget
      ? `${options.agentTarget.identity.localId}: ${result.errorCode}` : result.errorCode, {
      actionId,
      ...(result.details === undefined ? {} : { details: result.details }),
      ...(options?.agentTarget ? { agentTarget: options.agentTarget } : {}),
      // The Action-input owner has already projected these content-free repair facts.
      ...(typeof details.sessionId === 'string' ? { sessionId: details.sessionId } : {}),
      ...(errorDetail ? { errorDetail } : {}),
      ...(options?.failurePayload ?? {}),
    });
  }

  const domainResult = isRecord(result.result) ? result.result : {};
  if (isSessionSpawnNewActionIdV1(actionId) && domainResult.type === 'error' && options?.agentTarget) {
    // The Action owner validated this settlement; presentation adds the bound
    // Agent without changing the domain result or inferring a startup cause.
    const failure = result.result as Extract<SessionSpawnNewActionResultV1, { type: 'error' }>;
    const alternative = options.alternativeAgent;
    const context = { agentTarget: options.agentTarget,
      ...(alternative ? { alternativeAgent: alternative } : {}),
      errorMessage: `${options.agentTarget.identity.localId}: ${resolveSessionSpawnNewResultFailureMessage(failure)}${
        alternative ? ` ${alternative.label} is ready on this Machine. Would you like to use ${alternative.label} instead?` : ''}` };
    return options.canonicalResult ? JSON.stringify({ ...result, ...context }) : jsonOk({ ...domainResult, ...context });
  }
  if (domainResult.ok === false && domainResult.status === 'partial') {
    return JSON.stringify(options?.canonicalResult ? result : domainResult);
  }

  const nestedFailure = getNestedActionFailure(actionId, result.result);
  if (nestedFailure) {
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
