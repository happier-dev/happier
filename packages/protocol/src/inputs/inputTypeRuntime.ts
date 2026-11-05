import { SharedSavedSecretReferenceSelectionV1Schema } from '../account/settings/savedSecretReferenceV1.js';
import type { PublicActionInputById } from '../actions/actionSpecs.js';
import { z } from 'zod/mini';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '../plugins/actions/jsonSchemaValidation.js';
import { pluginJsonValuesEqual } from '../plugins/contributions/jsonSchemaValues.js';
import { normalizeStrictJsonValue, type JsonValue } from '../json/strictJsonValue.js';
import { qualifyPluginContributionReferenceV1, type PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import type { PluginInputTypeContributionV1 } from '../plugins/contributions/inputTypes.js';
import { InputOptionSchema, type InputOption, type InputFieldHint } from './inputFields.js';
import type { ActionExecutorDeps, ActionExecutorContext } from '../actions/executor/types.js';
import type { ActionExecuteResult } from '../actions/actionExecutionResult.js';
import { UsageQuerySchema, normalizeUsageQuery } from './usageQuery.js';
import { projectNativeJsonValueForTransport } from '../json/strictJsonValue.js';
import type { HostInputTypeReferenceV1, InputTypeReferenceV1 } from './inputTypes.js';
import { inputTypeOptionsSourceId } from './inputTypes.js';
import { VoiceTrackedSessionAddressV1Schema } from '../sessions/follow/voiceTrackedTargetsCompatibilityV1.js';
import { WorkspaceRefV1Schema } from '../workspaces/workspaceRefV1.js';
import { MachineTargetV1Schema } from '../machines/machineAccessV1.js';
import { normalizeExecutableParticipantSelectionV1 } from '../discussions/executableParticipants.js';

function isInputOptionAvailable(value: unknown, options: readonly Pick<InputOption, 'value' | 'disabled'>[]): boolean {
  return options.some(option => !option.disabled && pluginJsonValuesEqual(option.value, value));
}

/** Host schemas do not acquire a plugin occurrence or contributed Resource. */
export function validateHostInputTypeValue(reference: HostInputTypeReferenceV1, value: unknown, options?: readonly InputOption[]): ReturnType<typeof validateInputTypeValue> {
  if (options && !isInputOptionAvailable(value, options)) {
    return { status: 'invalid', reasonCode: 'input_type_option_invalid' };
  }
  if (reference.hostType === 'savedSecretReference') {
    const selected = SharedSavedSecretReferenceSelectionV1Schema.safeParse(value);
    return selected.success ? { status: 'valid', value: selected.data }
      : { status: 'invalid', reasonCode: 'input_type_value_invalid' };
  }
  if (reference.hostType === 'usageQuery') {
    if (reference.field) {
      const parsed = UsageQuerySchema.shape[reference.field].safeParse(value);
      return parsed.success ? { status: 'valid', value: projectNativeJsonValueForTransport(
        normalizeUsageQuery({ [reference.field]: parsed.data })[reference.field]) }
        : { status: 'invalid', reasonCode: 'input_type_value_invalid' };
    }
    const parsed = UsageQuerySchema.safeParse(value);
    return parsed.success ? { status: 'valid', value: projectNativeJsonValueForTransport(normalizeUsageQuery(parsed.data)) }
      : { status: 'invalid', reasonCode: 'input_type_value_invalid' };
  }
  if (reference.hostType === 'agentParticipant') {
    const participant = normalizeExecutableParticipantSelectionV1(value);
    return participant ? { status: 'valid', value: projectNativeJsonValueForTransport(participant) }
      : { status: 'invalid', reasonCode: 'input_type_value_invalid' };
  }
  const parsed = reference.hostType === 'session'
    ? VoiceTrackedSessionAddressV1Schema.safeParse(value)
    : reference.hostType === 'machine' ? MachineTargetV1Schema.safeParse(value) : WorkspaceRefV1Schema.safeParse(value);
  return parsed.success ? { status: 'valid', value: projectNativeJsonValueForTransport(parsed.data) }
    : { status: 'invalid', reasonCode: 'input_type_value_invalid' };
}

/** The existing options request is also the finite Resource query carrier. */
export type InputTypeOptionsQueryV1 = Readonly<Pick<PublicActionInputById['action.options.resolve'],
  'draftInput' | 'fieldPath' | 'query' | 'cursor'>>;

export type ResolvedInputTypeV1 = Readonly<{
  identity: PluginContributionIdentityV1;
  occurrenceId: string;
  definition: PluginInputTypeContributionV1;
}>;

/** A consuming field narrows the type's values; it owns any explicitly declared source. */
export function readInputFieldOptionsSourceId(field: Pick<InputFieldHint, 'inputType' | 'optionsSourceId'>): string | undefined {
  return field.optionsSourceId ?? (field.inputType ? inputTypeOptionsSourceId(field.inputType) : undefined);
}

/** Schema-only types and exact native refs do not invent a discovery prerequisite. */
export function readInputFieldOptionsConstraint(field: InputFieldHint, type?: ResolvedInputTypeV1 | null,
  viewerPurpose = false, selection: Readonly<{ contextBound?: boolean; value?: JsonValue }> = {}): Readonly<{ kind: 'none' }> | Readonly<{ kind: 'static'; options: readonly InputOption[] }> | Readonly<{ kind: 'dynamic' }> {
  // The binder owns followed values. Choices constrain own selections, and an empty
  // collection selects nothing (Usage's All), so neither needs a choice inventory.
  if (selection.contextBound || field.widget === 'multiselect' && Array.isArray(selection.value) && selection.value.length === 0)
    return { kind: 'none' };
  if (type?.definition.options) return { kind: 'dynamic' };
  if (field.options !== undefined) return { kind: 'static', options: field.options };
  if (field.optionsSourceId || field.connectedAccountOptions && !viewerPurpose) return { kind: 'dynamic' };
  return { kind: 'none' };
}

/** Schema admission can precede discovery without claiming that choices are resolved. */
export function validateInputFieldSchema(params: Readonly<{
  field: InputFieldHint; value: JsonValue; type?: ResolvedInputTypeV1 | null;
}>): ReturnType<typeof validateInputTypeValue> | Readonly<{ status: 'unavailable'; reasonCode: string }> {
  const { field, value, type } = params;
  const values = field.widget === 'multiselect' && Array.isArray(value) ? value : [value];
  const reference = field.inputType;
  if (reference && 'pluginId' in reference && (!type || type.identity.pluginId !== reference.pluginId
    || type.identity.localId !== reference.localId)) return { status: 'unavailable', reasonCode: 'input_type_unavailable' };
  let admitted: JsonValue = value;
  if (reference) {
    const normalized: JsonValue[] = [];
    for (const selected of values) {
      const result = 'hostType' in reference ? validateHostInputTypeValue(reference, selected)
        : validateInputTypeValue(type!, selected);
      if (result.status !== 'valid') return result;
      normalized.push(result.value);
    }
    admitted = field.widget === 'multiselect' && Array.isArray(value) ? normalized : normalized[0]!;
  }
  return { status: 'valid', value: admitted };
}

/** The values a field's choices must contain: a multiselect carries several, any other field one. */
export function readInputFieldSelectedValues(field: Pick<InputFieldHint, 'widget'>, value: JsonValue): readonly JsonValue[] {
  return field.widget === 'multiselect' && Array.isArray(value) ? value : [value];
}

/**
 * Full admission fails closed until every declared choice constraint is available. A `storedValue`
 * was admitted when it was written: choices are needed to pick a value, not to show one, so
 * unknown choices never retire it, while known choices that no longer name it still do.
 */
export function validateInputFieldValue(params: Readonly<{
  field: InputFieldHint; value: JsonValue; type?: ResolvedInputTypeV1 | null;
  options?: readonly Pick<InputOption, 'value' | 'disabled'>[]; viewerPurpose?: boolean; contextBound?: boolean;
  storedValue?: boolean;
}>): ReturnType<typeof validateInputFieldSchema> {
  const schema = validateInputFieldSchema(params);
  if (schema.status !== 'valid') return schema;
  if (params.contextBound) return schema;
  const constraint = readInputFieldOptionsConstraint(params.field, params.type, params.viewerPurpose, params);
  const options = constraint.kind === 'static' ? constraint.options : params.options;
  if (constraint.kind === 'dynamic' && options === undefined && !params.storedValue)
    return { status: 'unavailable', reasonCode: 'input_type_options_unavailable' };
  const values = readInputFieldSelectedValues(params.field, params.value);
  const fieldOptions = params.field.options;
  if (fieldOptions && values.some(selected => !isInputOptionAvailable(selected, fieldOptions)))
    return { status: 'invalid', reasonCode: 'input_type_option_invalid' };
  if (options && values.some(selected => !isInputOptionAvailable(selected, options)))
    return { status: 'invalid', reasonCode: 'input_type_option_invalid' };
  return schema;
}

/** Presentation projects the same admission; it never adds a second choice rule. */
export function narrowInputFieldOptions(params: Readonly<{ field: InputFieldHint; type?: ResolvedInputTypeV1 | null;
  options?: readonly InputOption[]; candidates?: readonly InputOption[] }>): readonly InputOption[] {
  return (params.candidates ?? params.field.options ?? params.options ?? []).filter(option =>
    validateInputFieldValue({ ...params, value: params.field.widget === 'multiselect' ? [option.value] : option.value }).status === 'valid');
}

/** The same value/schema/options admission applies to picker and headless values. */
export function validateInputTypeValue(type: ResolvedInputTypeV1, value: unknown,
  options?: readonly InputOption[]): Readonly<{ status: 'valid'; value: JsonValue }> | Readonly<{ status: 'invalid'; reasonCode: string }> {
  const validate = compilePluginJsonSchema(type.definition.valueSchema);
  if (!isValidPluginJsonSchemaValue(validate, value)) return { status: 'invalid', reasonCode: 'input_type_value_invalid' };
  if (options && !isInputOptionAvailable(value, options)) {
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
  identity: InputTypeReferenceV1;
  sessionId?: string;
  readFailure: (result: unknown) => Extract<ActionExecuteResult, { ok: false }> | null;
}>): Promise<Extract<ActionExecuteResult, { ok: false }> | Readonly<{ ok: true; result: readonly InputOption[]; optionsSourceId?: null }>> {
  const { deps, ctx, identity } = params;
  if ('hostType' in identity) return ctx.signal?.aborted
    ? { ok: false, errorCode: 'input_type_retired', error: 'input_type_retired' }
    : { ok: true, result: [], optionsSourceId: null };
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
