import type { HappierInputPickerPort, HappierInputPickerResult } from '@happier-dev/plugin-ui/presentation';
import {
    qualifyPluginContributionReferenceV1,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol/plugins/contribution-identity';
import { readActionInputOptionValue } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { InputFieldHint, InputOption, InputTypeReferenceV1 } from '@happier-dev/protocol/inputs';
import {
    invokeInputTypePicker,
    type InputTypePickerHostV1,
    type ResolvedInputTypeV1,
} from '@happier-dev/protocol/inputs/runtime';

import { t } from '@/text';

import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

/** Host-private discovery; Plugin UI forms continue to consume the unchanged exact-reference port. */
export type HostInputTypePickerPort = HappierInputPickerPort & Readonly<{
    resolveSemantic: (semantic: string, field: Pick<InputFieldHint, 'path'>) => PluginContributionIdentityV1 | null;
}>;

export function resolveSemanticInputTypePickerReference(port: HappierInputPickerPort | null,
    semantic: string, field: Pick<InputFieldHint, 'path'>): PluginContributionIdentityV1 | null {
    return port && hasSemanticLookup(port) ? port.resolveSemantic(semantic, field) : null;
}

function hasSemanticLookup(port: HappierInputPickerPort): port is HostInputTypePickerPort {
    return 'resolveSemantic' in port && typeof port.resolveSemantic === 'function';
}

export type InputTypePickerPortHost = Readonly<{
    /** The provider's existing scoped inventory, in its projection order; never another discovery read. */
    readInputTypes?: (field: Pick<InputFieldHint, 'path'>) => PluginUiProjectionModel['inputTypesById'] | undefined;
    /** The current admitted type for this identity, read anew on every call so a replaced plugin is seen. */
    resolveType: (identity: PluginContributionIdentityV1, field?: Pick<InputFieldHint, 'path'>) => ResolvedInputTypeV1 | null;
    /** Whether the host can mount this declared picker renderer now. */
    canOpenPicker: (picker: PluginContributionIdentityV1, type: ResolvedInputTypeV1, field?: Pick<InputFieldHint, 'path'>) => boolean;
    /** The incumbent ephemeral plugin-surface mount; it owns the renderer, its lifetime and disposal. */
    openPicker: (request: Parameters<InputTypePickerHostV1['openPicker']>[0], field?: Pick<InputFieldHint, 'path'>) => ReturnType<InputTypePickerHostV1['openPicker']>;
    openHostPicker?: (request: Parameters<NonNullable<InputTypePickerHostV1['openHostPicker']>>[0], field: InputFieldHint) => ReturnType<NonNullable<InputTypePickerHostV1['openHostPicker']>>;
    /** A host reference is only offered when its demanded picker surface exists. */
    canOpenHostPicker?: (reference: Extract<InputTypeReferenceV1, { hostType: string }>) => boolean;
}>;

/**
 * The host side of a typed field's custom picker, shared by Action, Workflow and widget forms.
 * Admission, retirement and value validation are the Protocol picker owner's
 * (`invokeInputTypePicker`): the answer meets the same schema and options an agent's value does.
 * This adapter only says whether a picker is offered and puts the outcome in the reader's words.
 */
export function createInputTypePickerPort(host: InputTypePickerPortHost): HostInputTypePickerPort {
    const pickerFor = (identity: InputTypeReferenceV1 | undefined, field: Pick<InputFieldHint, 'path'>): PluginContributionIdentityV1 | null => {
        if (identity === undefined) return null;
        if ('hostType' in identity) return null;
        const type = host.resolveType(identity, field);
        const picker = type?.definition.picker;
        if (type === null || picker === undefined) return null;
        const qualified = qualifyPluginContributionReferenceV1(picker, type.identity.pluginId);
        return host.canOpenPicker(qualified, type, field) ? qualified : null;
    };
    return {
        resolveSemantic: (semantic, field) => {
            // First available match in the existing projection order wins; no second precedence catalog.
            for (const entry of Object.values(host.readInputTypes?.(field) ?? {})) {
                if (entry.definition.semantic !== semantic) continue;
                const identity = { pluginId: entry.pluginId, localId: entry.definition.id };
                if (pickerFor(identity, field)) return identity;
            }
            return null;
        },
        describe: (field) => (field.inputType && 'hostType' in field.inputType
            // A Usage field (the Period, the Session) offers its choices in place from its type's own
            // source; only a whole Usage query opens the host's dialog. The field is named by its type,
            // because a group saved before its choices were declared still carries the older hint.
            ? host.openHostPicker !== undefined && (
                field.inputType.hostType === 'agentParticipant' && host.canOpenHostPicker?.(field.inputType) === true
                || field.inputType.hostType === 'usageQuery' && field.inputType.field === undefined
                    && field.optionsSourceId === undefined && field.options === undefined)
            : pickerFor(field.inputType, field) !== null) ? {
            label: t('inputPicker.browse'),
            accessibilityLabel: t('inputPicker.browseField', { field: field.title }),
        } : null,
        pick: async (request): Promise<HappierInputPickerResult> => {
            const inputType = request.field.inputType;
            if (inputType === undefined) return { status: 'error', message: describePickerError('input_type_unavailable') };
            const field = { ...request.field, widget: request.field.widget === 'multiselect' ? 'multiselect' as const : 'select' as const };
            const options = request.options?.flatMap((option): InputOption[] => {
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
                    ...field,
                    // Preserve declared empty constraints. An empty presentation list alone
                    // invents no static constraint; Protocol still enforces declared sources.
                    ...(field.options === undefined && request.options?.length ? { options } : {}),
                },
                ...(current === undefined ? {} : { value: current }),
                signal: request.signal,
                host: {
                    resolveType: async (identity) => host.resolveType(identity, field),
                    resolveOptions: async () => options ?? { errorCode: 'input_type_options_unavailable' },
                    openPicker: picker => host.openPicker(picker, field),
                    ...(host.openHostPicker ? { openHostPicker: (pickerRequest: Parameters<NonNullable<InputTypePickerHostV1['openHostPicker']>>[0]) => host.openHostPicker!(pickerRequest, field) } : {}),
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
