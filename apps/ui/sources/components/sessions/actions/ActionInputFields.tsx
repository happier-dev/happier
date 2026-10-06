import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import {
    actionInputOptionValueKey,
    isSameActionInputOptionValue,
    readActionInputOptionValue,
    type ActionInputFieldHint,
    type ActionInputOptionValue,
    type EffectiveActionInputField,
} from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import {
    HappierForm,
    HappierInputField,
    patchHappierActionInputPath,
    readHappierActionInputPath,
    resolveHappierActionFieldPresentation,
    type HappierActionFieldPresentation,
    type HappierSelectOption,
} from '@happier-dev/plugin-ui/presentation';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { SurfaceStateCard } from '@/components/ui/surfaces';
import { t } from '@/text';
import type { ResolveSessionActionFieldOptions } from './sessionActionFieldOptions';
import { InputTypePickerHostProvider } from './InputTypePickerHostProvider';

export type ActionFieldOption = Readonly<{
    value: ActionInputOptionValue;
    label: string;
    /** Host-resolved account labels can include a bounded, safe subtitle. */
    description?: string;
    disabled?: boolean;
}>;

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

/**
 * The presentation this file renders a field from, for a given input record.
 *
 * Exported so the transcript row's height-bearing descriptor
 * (`resolveSessionActionDraftHeightBearingPaint`) reads the SAME resolution — including the exact
 * `text` value a `HappierTextField` displays — instead of restating the widget/display rule in a
 * second place where it can drift from the paint.
 */
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
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);

    return (
        <InputTypePickerHostProvider enabled={props.fields.some((field) => field.inputType !== undefined)}
            {...props.resolveFieldOptions.pickerContext}>
        <HappierForm busy={props.busy}>
            {props.fields.map((field) => {
                const path = typeof field?.path === 'string' ? field.path : '';
                const widget = typeof field?.widget === 'string' ? field.widget : '';
                if (!path || !widget) return null;
                const label = typeof field?.title === 'string' ? field.title : path;
                const value = readHappierActionInputPath(props.input, path);
                const selection = readActionInputSelectionForPresentation(field, value);
                const choices = widget === 'select' || widget === 'multiselect';
                const optionState = choices ? props.resolveFieldOptions.state?.(field) : undefined;
                const selectedValues = Array.isArray(selection) ? selection : (selection === undefined ? [] : [selection]);
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
                        {...(optionState === undefined ? {} : { optionsStatus: optionState.status })}
                        optionsNotice={optionState?.status === 'failed' ? <SurfaceStateCard kind="error" size="line" title={t('common.error')}
                            diagnosticCode={optionState.errorCode}
                            action={props.resolveFieldOptions.retry ? { label: t('common.retry'), onPress: props.resolveFieldOptions.retry } : undefined} /> : null}
                        disabled={!props.editable}
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
        </InputTypePickerHostProvider>
    );
}
