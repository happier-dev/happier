import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import {
    actionInputOptionValueKey,
    isSameActionInputOptionValue,
    readActionInputOptionValue,
    type ActionInputFieldHint,
    type ActionInputOption,
    type ActionInputOptionValue,
    type EffectiveActionInputField,
} from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import {
    HappierForm,
    happierFormMarksOptionalFields,
    HappierInputField,
    patchHappierActionInputPath,
    readHappierActionInputPath,
    resolveHappierActionFieldPresentation,
    type HappierActionFieldPresentation,
    type HappierSelectOption,
} from '@happier-dev/plugin-ui/presentation';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { SurfaceStateCard } from '@/components/ui/surfaces';
import { t } from '@/text';
import type { ResolveSessionActionFieldOptions } from './sessionActionFieldOptions';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { InputTypePickerHostProvider } from './InputTypePickerHostProvider';

export type ActionFieldOption = ActionInputOption;

const FIELD_STYLE = { marginTop: 10 } as const;

/** Compatibility names for existing core callers; algorithms live in plugin-ui presentation. */
export const getValueAtPath = readHappierActionInputPath;
export const setValueAtTopLevelPatch = patchHappierActionInputPath;

function readActionInputSelectionForPresentation(
    field: Pick<ActionInputFieldHint, 'widget'>,
    value: unknown,
): ActionInputOptionValue | readonly ActionInputOptionValue[] | undefined {
    if (field.widget === 'select') return readActionInputOptionValue(value);
    if (field.widget !== 'multiselect') return undefined;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        const optionValue = readActionInputOptionValue(item);
        return optionValue === undefined ? [] : [optionValue];
    });
}

/** The presentation this file renders a field from, for a given input record. */
export function resolveActionFieldPresentationForInput(
    field: ActionInputFieldHint,
    input: Record<string, unknown>,
): HappierActionFieldPresentation<ActionInputOptionValue> | null {
    const path = typeof field?.path === 'string' ? field.path : '';
    const widget = typeof field?.widget === 'string' ? field.widget : '';
    if (!path || !widget) return null;
    const value = readHappierActionInputPath(input, path);
    return resolveHappierActionFieldPresentation<ActionInputOptionValue>(
        field,
        value,
        readActionInputSelectionForPresentation(field, value),
    );
}

/** A declared choice reads by the same options as its picker; unavailable choices never become raw identifiers. */
export function formatActionInputFieldChoice(
    field: ActionInputFieldHint,
    value: unknown,
    resolveOptions: ResolveSessionActionFieldOptions,
): string | null {
    if (field.widget !== 'select' && field.widget !== 'multiselect') return null;
    const selection = readActionInputSelectionForPresentation(field, value);
    const values = field.widget === 'multiselect' && Array.isArray(selection) ? selection
        : selection === undefined ? [] : [selection];
    if (values.length === 0) return null;
    const options = resolveOptions(field);
    const labels = values.map(selected => options.find(option => isSameActionInputOptionValue(selected, option.value))?.label);
    if (labels.every(label => label !== undefined)) return labels.join(', ');
    if (selection === null || selection === '') return null;
    if (field.allowCustomValue === true) return null;
    return resolveOptions.state?.(field).status === 'loading' ? t('common.loading') : t('common.unavailable');
}

export function ActionInputFields(props: Readonly<{
    /**
     * Forms resolve visibility, requiredness, and disabled state at the Protocol
     * input-hints owner before entering this shared presentation adapter.
     */
    fields: readonly EffectiveActionInputField[];
    input: Record<string, unknown>;
    editable: boolean;
    /** Submission state projected by the form lifecycle owner. */
    busy?: boolean;
    resolveFieldOptions: ResolveSessionActionFieldOptions;
    onPatch: (patch: Record<string, unknown>) => void;
    resolveFieldTestID?: (field: EffectiveActionInputField) => string | undefined;
    /** `none`: an enclosing row already names the field, so the control draws no label of its own. */
    frame?: 'field' | 'none';
    getChipAccessibilityLabel?: (args: Readonly<{
        field: EffectiveActionInputField;
        option: ActionFieldOption;
        selected: boolean;
    }>) => string | undefined;
}>) {
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);

    return (
        <InputTypePickerHostProvider enabled={props.fields.some((field) => field.inputType !== undefined)}
            requiresPluginTypes={props.fields.some(field => field.inputType !== undefined && 'pluginId' in field.inputType)}
            {...props.resolveFieldOptions.pickerContext}>
        <CoreCollectionScope>
        <HappierForm busy={props.busy} marksOptionalFields={happierFormMarksOptionalFields(props.fields)}>
            {props.fields.map((field) => {
                const path = typeof field?.path === 'string' ? field.path : '';
                const widget = typeof field?.widget === 'string' ? field.widget : '';
                if (!path || !widget) return null;
                const label = typeof field?.title === 'string' ? field.title : path;
                const value = readHappierActionInputPath(props.input, path);
                const selection = readActionInputSelectionForPresentation(field, value);
                const choices = widget === 'select' || widget === 'multiselect';
                const optionState = choices ? props.resolveFieldOptions.state?.(field) : undefined;
                // Choices that read another field's answer wait for it: the field stays closed and says what to choose
                // first, rather than reporting the owner's dependency refusal as a failed read.
                const waitsOn = optionState?.status === 'failed' && optionState.errorCode === 'missing_option_dependency'
                    ? props.fields.find(candidate => candidate.path === optionState.requiredDraftPath) : undefined;
                const waitingReading = waitsOn
                    ? t('workflows.start.choicesNeedField', { field: typeof waitsOn.title === 'string' ? waitsOn.title : waitsOn.path })
                    : undefined;
                const selectedValues = widget === 'multiselect' && Array.isArray(selection)
                    ? selection : (selection === undefined ? [] : [selection]);
                const options: readonly HappierSelectOption<ActionInputOptionValue>[] = choices
                    ? props.resolveFieldOptions(field).map((option) => ({
                        ...option,
                        accessibilityLabel: props.getChipAccessibilityLabel?.({
                            field,
                            option,
                            selected: selectedValues.some((selected) => isSameActionInputOptionValue(selected, option.value)),
                        }),
                    }))
                    : [];
                const toggleLabel = widget === 'boolean'
                    ? props.getChipAccessibilityLabel?.({
                        field,
                        option: { value: String(value === true), label },
                        selected: value === true,
                    })
                    : undefined;
                return (
                    <HappierInputField<ActionInputOptionValue>
                        key={path}
                        field={{ ...field, title: label }}
                        value={value}
                        selection={selection}
                        options={options}
                        {...(optionState === undefined ? {} : { optionsStatus: waitingReading === undefined ? optionState.status : 'loading' })}
                        {...(waitingReading === undefined ? {} : { valueLabel: waitingReading })}
                        optionsNotice={optionState?.status === 'failed' && waitingReading === undefined ? <SurfaceStateCard kind="error" size="line" title={t('workflows.start.choicesFailed')}
                            diagnosticCode={optionState.errorCode}
                            action={props.resolveFieldOptions.retry ? { label: t('common.retry'), onPress: props.resolveFieldOptions.retry } : undefined} /> : null}
                        disabled={!props.editable || waitingReading !== undefined}
                        isEqual={isSameActionInputOptionValue}
                        keyForOption={(option) => actionInputOptionValueKey(option.value)}
                        {...(toggleLabel === undefined ? {} : { toggleLabel })}
                        {...(widget === 'boolean' ? {} : { controlTestID: props.resolveFieldTestID?.(field) })}
                        {...(props.frame === undefined ? {} : { frame: props.frame })}
                        style={FIELD_STYLE}
                        theme={presentationTheme}
                        onChange={(next) => props.onPatch(patchHappierActionInputPath(props.input, path, next))}
                    />
                );
            })}
        </HappierForm>
        </CoreCollectionScope>
        </InputTypePickerHostProvider>
    );
}
