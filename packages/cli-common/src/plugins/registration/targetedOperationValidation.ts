/** @moduleRealm any */
import type { JsonValue, RehydratedPluginContributionPointOperationV1 } from '@happier-dev/protocol';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import { readActionSessionReadSetOperand } from '@happier-dev/protocol/actions/executor/sessionTargets';
import { isActionSessionReadSetV1, type ActionSessionTargetDeclarationV1 } from '@happier-dev/protocol/actions/sessionTargetV1';

/** Existing targeted-operation failure contract, before or after handler entry. */
export type TargetedOperationValidationFailure = Readonly<{
    ok: false;
    errorCode: string;
    error: string;
    actionHandlerInvocation?: 'notStarted';
}>;

function actionHandlerNotStartedFailure(errorCode: string, error: string): TargetedOperationValidationFailure {
    return { ok: false, errorCode, error, actionHandlerInvocation: 'notStarted' };
}

function targetedOperationInputInvalid(): TargetedOperationValidationFailure {
  return actionHandlerNotStartedFailure(
    'plugin_targeted_operation_input_invalid',
    'Targeted operation input does not match the target protocol',
  );
}

function targetedOperationResultInvalid(): TargetedOperationValidationFailure {
  return {
    ok: false,
    errorCode: 'plugin_targeted_operation_result_invalid',
    error: 'Targeted operation result does not match the target protocol',
  };
}

export function validateTargetedOperationInput(
  targetProtocol: RehydratedPluginContributionPointOperationV1,
  input: unknown,
): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; result: TargetedOperationValidationFailure }> {
  if (targetProtocol.input.kind === 'contributorDefined') {
    return Object.freeze({ ok: true as const, value: input });
  }
  try {
    const parsed = targetProtocol.input.schema.safeParse(input);
    if (parsed.success) return Object.freeze({ ok: true as const, value: parsed.data });
  } catch {
    // Target-owned parser failures reject before a contributor Action starts.
  }
  return Object.freeze({ ok: false as const, result: targetedOperationInputInvalid() });
}

export function validateTargetedOperationResult(
  targetProtocol: RehydratedPluginContributionPointOperationV1,
  result: JsonValue,
  sessionReadSet?: Readonly<{ declaration?: ActionSessionTargetDeclarationV1; input: unknown }>,
): Readonly<{ ok: true; value: JsonValue }> | Readonly<{ ok: false; result: TargetedOperationValidationFailure }> {
  const declaration = sessionReadSet?.declaration;
  const input = sessionReadSet?.input;
  const operand = declaration && isActionSessionReadSetV1(declaration)
    && input !== null && typeof input === 'object' && !Array.isArray(input)
    ? readActionSessionReadSetOperand(input as Readonly<Record<string, unknown>>, declaration).value
    : undefined;
  const sessionIds: unknown[] | undefined = Array.isArray(operand) && operand.length > 0 ? operand : undefined;
  const envelope = sessionIds
    && isJsonObject(result) && result.kind === 'sessionReadSet' && Object.hasOwn(result, 'result') && Array.isArray(result.failures)
    ? result
    : undefined;

  if (sessionIds && envelope?.result === null) {
    // Admission does not run the handler when the refusals cover the whole set.
    // A handler that returns null for an admitted Session still owes the schema.
    const requested = new Set(sessionIds.map(id => typeof id === 'string' ? id.trim() : id));
    const failures: readonly JsonValue[] = envelope.failures as readonly JsonValue[];
    if (failures.length === requested.size && failures.every(failure =>
      isJsonObject(failure) && typeof failure.sessionId === 'string' && requested.delete(failure.sessionId))) {
      return Object.freeze({ ok: true as const, value: envelope });
    }
  }

  try {
    const parsed = targetProtocol.resultSchema.safeParse(envelope ? envelope.result : result);
    if (parsed.success) {
      return Object.freeze({ ok: true as const, value: envelope ? { ...envelope, result: parsed.data } : parsed.data });
    }
  } catch {
    // Target-owned parser failures cannot expose a contributor Action result.
  }
  return Object.freeze({ ok: false as const, result: targetedOperationResultInvalid() });
}
