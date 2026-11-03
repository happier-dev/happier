/** @moduleRealm any */
import type { JsonValue, RehydratedPluginContributionPointOperationV1 } from '@happier-dev/protocol';

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
  result: JsonValue | null,
): Readonly<{ ok: true; value: JsonValue }> | Readonly<{ ok: false; result: TargetedOperationValidationFailure }> {
  try {
    const parsed = targetProtocol.resultSchema.safeParse(result);
    if (parsed.success) return Object.freeze({ ok: true as const, value: parsed.data });
  } catch {
    // Target-owned parser failures cannot expose a contributor Action result.
  }
  return Object.freeze({ ok: false as const, result: targetedOperationResultInvalid() });
}
