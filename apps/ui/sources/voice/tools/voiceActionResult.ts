import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { isRecord } from '@happier-dev/protocol/common/records';
import { normalizeSpawnSessionErrorDetail } from '@happier-dev/protocol/spawnSession';
import { SessionMessageReplyMutationResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';

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

function getNestedActionFailure(actionId: ActionId, value: unknown): { errorCode: string; errorMessage: string } | null {
  if (actionId === 'session.message.reply') {
    const reply = SessionMessageReplyMutationResultV1Schema.safeParse(value);
    if (reply.success && !reply.data.ok) {
      return { errorCode: reply.data.error, errorMessage: reply.data.error };
    }
  }
  const carrier = isRecord(value) ? value : {};
  if (carrier.success === false) {
    const errorCode = String(carrier.errorCode ?? carrier.code ?? 'unknown_error');
    return { errorCode, errorMessage: errorCode };
  }
  if (carrier.ok !== false) return null;
  return {
    errorCode: String(carrier.errorCode ?? 'unknown_error'),
    errorMessage: String(carrier.errorMessage ?? carrier.errorCode ?? 'unknown_error'),
  };
}

export function serializeVoiceActionExecuteResult(
  actionId: ActionId,
  result: ActionExecuteResult,
  options?: Readonly<{
    failurePayload?: Record<string, unknown>;
    executedPayload?: Record<string, unknown>;
    canonicalResult?: boolean;
  }>,
): string {
  if (!result.ok) {
    const details = isRecord(result.details) ? result.details : {};
    const errorDetail = normalizeSpawnSessionErrorDetail(details.errorDetail);
    return jsonError(result.errorCode, result.errorCode, {
      actionId,
      ...(typeof details.sessionId === 'string' ? { sessionId: details.sessionId } : {}),
      ...(errorDetail ? { errorDetail } : {}),
      ...(options?.failurePayload ?? {}),
    });
  }

  const domainResult = isRecord(result.result) ? result.result : {};
  if (domainResult.ok === false && domainResult.status === 'partial') {
    return JSON.stringify(options?.canonicalResult ? result : domainResult);
  }

  const nestedFailure = getNestedActionFailure(actionId, result.result);
  if (nestedFailure) {
    return jsonError(nestedFailure.errorCode, nestedFailure.errorMessage, {
      actionId,
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
