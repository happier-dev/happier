import { z } from 'zod';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '../plugins/actions/jsonSchemaValidation.js';
import { pluginJsonValuesEqual } from '../plugins/contributions/jsonSchemaValues.js';
import { normalizeStrictJsonValue, type JsonValue } from '../json/strictJsonValue.js';
import { qualifyPluginContributionReferenceV1, type PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import type { PluginInputTypeContributionV1 } from '../plugins/contributions/inputTypes.js';
import { InputOptionSchema, type InputOption } from './inputFields.js';
import type { ActionExecutorDeps, ActionExecutorContext } from '../actions/executor/types.js';
import type { ActionExecuteResult } from '../actions/actionExecutionResult.js';

export type ResolvedInputTypeV1 = Readonly<{
  identity: PluginContributionIdentityV1;
  occurrenceId: string;
  definition: PluginInputTypeContributionV1;
}>;

/** The same value/schema/options admission applies to picker and headless values. */
export function validateInputTypeValue(type: ResolvedInputTypeV1, value: unknown,
  options?: readonly InputOption[]): Readonly<{ status: 'valid'; value: JsonValue }> | Readonly<{ status: 'invalid'; reasonCode: string }> {
  const validate = compilePluginJsonSchema(type.definition.valueSchema);
  if (!isValidPluginJsonSchemaValue(validate, value)) return { status: 'invalid', reasonCode: 'input_type_value_invalid' };
  if (options && !options.some(option => !option.disabled && pluginJsonValuesEqual(option.value, value))) {
    return { status: 'invalid', reasonCode: 'input_type_option_invalid' };
  }
  return { status: 'valid', value: normalizeStrictJsonValue(value) };
}

/** Resource payloads are typed options, never the built-in inventory coercion dialect. */
export function readInputTypeOptions(type: ResolvedInputTypeV1, payload: unknown): readonly InputOption[] | null {
  const parsed = z.array(InputOptionSchema).safeParse(payload);
  if (!parsed.success) return null;
  return parsed.data.every(option => validateInputTypeValue(type, option.value).status === 'valid') ? parsed.data : null;
}

export function inputTypeResourceReference(type: ResolvedInputTypeV1): PluginContributionIdentityV1 | null {
  return type.definition.options
    ? qualifyPluginContributionReferenceV1(type.definition.options.resource, type.identity.pluginId) : null;
}

/** Shared Resource admission; source selection remains in the single options resolver. */
export async function resolveInputTypeOptions(params: Readonly<{
  deps: Pick<ActionExecutorDeps, 'resolveInputType' | 'readInputTypeResource'>;
  ctx: ActionExecutorContext;
  identity: PluginContributionIdentityV1;
  sessionId?: string;
  readFailure: (result: unknown) => Extract<ActionExecuteResult, { ok: false }> | null;
}>): Promise<Extract<ActionExecuteResult, { ok: false }> | Readonly<{ ok: true; result: readonly InputOption[]; optionsSourceId?: null }>> {
  const { deps, ctx, identity } = params;
  if (!deps.resolveInputType) {
    return { ok: false, errorCode: 'input_type_unavailable', error: 'input_type_unavailable' };
  }
  const type = await deps.resolveInputType(identity, ctx);
  if (!type || type.identity.pluginId !== identity.pluginId || type.identity.localId !== identity.localId) {
    return { ok: false, errorCode: 'input_type_unavailable', error: 'input_type_unavailable' };
  }
  const resource = inputTypeResourceReference(type);
  if (!resource) return { ok: true, result: [], optionsSourceId: null };
  if (!deps.readInputTypeResource) return { ok: false, errorCode: 'input_type_options_unavailable', error: 'input_type_options_unavailable' };
  const result = await deps.readInputTypeResource({ type, resource, context: ctx,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}) });
  const failure = params.readFailure(result);
  if (failure) return failure;
  const current = await deps.resolveInputType(identity, ctx);
  if (ctx.signal?.aborted || !current || current.occurrenceId !== type.occurrenceId) {
    return { ok: false, errorCode: 'input_type_retired', error: 'input_type_retired' };
  }
  const options = readInputTypeOptions(type, result);
  return options ? { ok: true, result: options }
    : { ok: false, errorCode: 'input_type_options_invalid', error: 'input_type_options_invalid' };
}
