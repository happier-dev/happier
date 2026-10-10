import type { HappierInputPickerPort, HappierInputPickerResult } from '@happier-dev/plugin-ui/presentation';
import {
    qualifyPluginContributionReferenceV1,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol/plugins/contribution-identity';
import { readActionInputOptionValue } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { InputOption, InputTypeReferenceV1 } from '@happier-dev/protocol/inputs';
import {
    invokeInputTypePicker,
    type InputTypePickerHostV1,
    type ResolvedInputTypeV1,
} from '@happier-dev/protocol/inputs/runtime';

import { t } from '@/text';

export type InputTypePickerPortHost = Readonly<{
    /** The current admitted type for this identity, read anew on every call so a replaced plugin is seen. */
    resolveType: (identity: PluginContributionIdentityV1) => ResolvedInputTypeV1 | null;
    /** Whether the host can mount this declared picker renderer now. */
    canOpenPicker: (picker: PluginContributionIdentityV1, type: ResolvedInputTypeV1) => boolean;
    /** The incumbent ephemeral plugin-surface mount; it owns the renderer, its lifetime and disposal. */
    openPicker: InputTypePickerHostV1['openPicker'];
    openHostPicker?: InputTypePickerHostV1['openHostPicker'];
}>;

/**
 * The host side of a typed field's custom picker, shared by Action, Workflow and widget forms.
 * Admission, retirement and value validation are the Protocol picker owner's
 * (`invokeInputTypePicker`): the answer meets the same schema and options an agent's value does.
 * This adapter only says whether a picker is offered and puts the outcome in the reader's words.
 */
export function createInputTypePickerPort(host: InputTypePickerPortHost): HappierInputPickerPort {
    const pickerFor = (identity: InputTypeReferenceV1 | undefined): PluginContributionIdentityV1 | null => {
        if (identity === undefined) return null;
        if ('hostType' in identity) return null;
        const type = host.resolveType(identity);
        const picker = type?.definition.picker;
        if (type === null || picker === undefined) return null;
        const qualified = qualifyPluginContributionReferenceV1(picker, type.identity.pluginId);
        return host.canOpenPicker(qualified, type) ? qualified : null;
    };
    return {
        describe: (field) => (field.inputType && 'hostType' in field.inputType
            ? field.inputType.hostType === 'usageQuery' && host.openHostPicker !== undefined
            : pickerFor(field.inputType) !== null) ? {
            label: t('inputPicker.browse'),
            accessibilityLabel: t('inputPicker.browseField', { field: field.title }),
        } : null,
        pick: async (request): Promise<HappierInputPickerResult> => {
            const inputType = request.field.inputType;
            if (inputType === undefined) return { status: 'error', message: describePickerError('input_type_unavailable') };
            // Host semantic pickers have no discovery Resource. The shared select control's
            // empty presentation list is not an authoritative empty inventory.
            const presentedOptions = 'hostType' in inputType && inputType.hostType === 'usageQuery'
                && request.options?.length === 0 ? undefined : request.options;
            const options = presentedOptions?.flatMap((option): InputOption[] => {
                const value = readActionInputOptionValue(option.value);
                return value === undefined ? [] : [{
                    value,
                    label: option.label,
                    ...(option.description === undefined ? {} : { description: option.description }),
                    ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
                }];
            });
            const current = readActionInputOptionValue(request.value);
            const result = await invokeInputTypePicker({
                field: {
                    path: request.field.path,
                    title: request.field.title,
                    widget: 'select',
                    inputType,
                    ...(options === undefined ? {} : { options }),
                },
                ...(current === undefined ? {} : { value: current }),
                signal: request.signal,
                host: {
                    resolveType: async (identity) => host.resolveType(identity),
                    resolveOptions: async () => options ?? { errorCode: 'input_type_options_unavailable' },
                    openPicker: host.openPicker,
                    ...(host.openHostPicker ? { openHostPicker: host.openHostPicker } : {}),
                },
            });
            if (result.status === 'selected') return { status: 'selected', value: result.value };
            if (result.status === 'cancelled') return { status: 'cancelled' };
            return { status: 'error', message: describePickerError(result.reasonCode) };
        },
    };
}

function describePickerError(reasonCode: string): string {
    switch (reasonCode) {
        case 'input_type_unavailable':
        case 'input_type_picker_unavailable':
            return t('inputPicker.unavailable');
        case 'input_type_retired':
            return t('inputPicker.retired');
        case 'input_type_value_invalid':
        case 'input_type_option_invalid':
        case 'input_type_picker_result_invalid':
            return t('inputPicker.invalid');
        default:
            return t('inputPicker.failed');
    }
}
