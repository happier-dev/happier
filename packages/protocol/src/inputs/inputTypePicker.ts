import { qualifyPluginContributionReferenceV1, type PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import { PluginUiEphemeralInputSettlementV1Schema } from '../plugins/ui/hostApiRequests.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import type { InputOption, InputFieldHint } from './inputFields.js';
import { readInputFieldOptionsConstraint, validateInputFieldValue, type ResolvedInputTypeV1 } from './inputTypeRuntime.js';
import type { InputTypePickerLaunchInputV1 } from './inputTypePickerContract.js';
import type { HostInputTypeReferenceV1 } from './inputTypes.js';
import { USAGE_QUERY_INPUT_FIELDS } from './usageQuery.js';

export type InputTypePickerResultV1 =
  | Readonly<{ status: 'selected'; value: JsonValue }>
  | Readonly<{ status: 'cancelled' }>
  | Readonly<{ status: 'error'; reasonCode: string }>;
export type InputTypePickerHostV1 = Readonly<{
  /** Host semantic types use the incumbent generic input form, never a plugin mount. */
  openHostPicker?(request: Readonly<{ reference: HostInputTypeReferenceV1; fields: readonly InputFieldHint[];
    value?: JsonValue; signal: AbortSignal }>): Promise<unknown>;
  resolveType(identity: PluginContributionIdentityV1): Promise<ResolvedInputTypeV1 | null>;
  resolveOptions(field: InputFieldHint): Promise<readonly InputOption[] | Readonly<{ errorCode: string }>>;
  /** The incumbent admitted ephemeral UI mount owns renderer selection and disposal. */
  openPicker(request: Readonly<{ picker: PluginContributionIdentityV1; type: ResolvedInputTypeV1;
    launchInput: InputTypePickerLaunchInputV1; signal: AbortSignal }>): Promise<unknown>;
}>;

export async function invokeInputTypePicker(request: Readonly<{
  field: InputFieldHint; value?: JsonValue; host: InputTypePickerHostV1; signal: AbortSignal;
}>): Promise<InputTypePickerResultV1> {
  const { field, host, signal } = request;
  if (signal.aborted) return { status: 'cancelled' };
  if (!field.inputType) return { status: 'error', reasonCode: 'input_type_unavailable' };
  try {
    if ('hostType' in field.inputType) {
      if (field.inputType.hostType !== 'usageQuery') return { status: 'error', reasonCode: 'input_type_picker_unavailable' };
      if (!host.openHostPicker) return { status: 'error', reasonCode: 'input_type_picker_unavailable' };
      const constraint = readInputFieldOptionsConstraint(field);
      const options = constraint.kind === 'static' ? constraint.options : constraint.kind === 'dynamic' ? await host.resolveOptions(field) : undefined;
      if (signal.aborted) return { status: 'cancelled' };
      if (options && 'errorCode' in options) return { status: 'error', reasonCode: options.errorCode };
      const reference = field.inputType;
      const answer = await host.openHostPicker({ reference,
        fields: reference.field ? USAGE_QUERY_INPUT_FIELDS.filter(candidate => candidate.path === reference.field) : USAGE_QUERY_INPUT_FIELDS,
        ...(request.value === undefined ? {} : { value: request.value }), signal });
      if (signal.aborted) return { status: 'cancelled' };
      const settled = PluginUiEphemeralInputSettlementV1Schema.safeParse(answer);
      if (!settled.success) return { status: 'error', reasonCode: 'input_type_picker_result_invalid' };
      if (settled.data.kind === 'cancelled') return { status: 'cancelled' };
      const validation = validateInputFieldValue({ field, value: settled.data.input, options });
      return validation.status === 'valid' ? { status: 'selected', value: validation.value }
        : { status: 'error', reasonCode: validation.reasonCode };
    }
    const type = await host.resolveType(field.inputType);
    if (!type || type.identity.pluginId !== field.inputType.pluginId || type.identity.localId !== field.inputType.localId) {
      return { status: 'error', reasonCode: 'input_type_unavailable' };
    }
    if (!type.definition.picker) return { status: 'error', reasonCode: 'input_type_picker_unavailable' };
    const constraint = readInputFieldOptionsConstraint(field, type);
    const options = constraint.kind === 'static' ? constraint.options : constraint.kind === 'dynamic' ? await host.resolveOptions(field) : undefined;
    if (signal.aborted) return { status: 'cancelled' };
    if (options && 'errorCode' in options) return { status: 'error', reasonCode: options.errorCode };
    const currentBeforeMount = await host.resolveType(field.inputType);
    if (signal.aborted) return { status: 'cancelled' };
    if (currentBeforeMount?.occurrenceId !== type.occurrenceId) return { status: 'error', reasonCode: 'input_type_retired' };
    const answer = await host.openPicker({ type, signal,
      launchInput: { inputType: type.identity, semantic: type.definition.semantic,
        ...(options === undefined ? {} : { options }), ...(request.value === undefined ? {} : { value: request.value }) },
      picker: qualifyPluginContributionReferenceV1(type.definition.picker, type.identity.pluginId) });
    if (signal.aborted) return { status: 'cancelled' };
    const current = await host.resolveType(field.inputType);
    if (current?.occurrenceId !== type.occurrenceId) return { status: 'error', reasonCode: 'input_type_retired' };
    const settled = PluginUiEphemeralInputSettlementV1Schema.safeParse(answer);
    if (!settled.success) return { status: 'error', reasonCode: 'input_type_picker_result_invalid' };
    if (settled.data.kind === 'cancelled') return { status: 'cancelled' };
    const validation = validateInputFieldValue({ field, type, value: settled.data.input, options });
    return validation.status === 'valid' ? { status: 'selected', value: validation.value }
      : { status: 'error', reasonCode: validation.reasonCode };
  } catch {
    return signal.aborted ? { status: 'cancelled' } : { status: 'error', reasonCode: 'input_type_picker_failed' };
  }
}
