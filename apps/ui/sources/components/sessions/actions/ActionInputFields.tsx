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
    HappierField,
    HappierForm,
    HappierSelect,
    HappierTextField,
    HappierToggle,
    patchHappierActionInputPath,
    readHappierActionInputPath,
    resolveHappierActionFieldPresentation,
    type HappierActionFieldPresentation,
    type HappierSelectOption,
} from '@happier-dev/plugin-ui/presentation';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

export type ActionFieldOption = Readonly<{
    value: ActionInputOptionValue;
    label: string;
    /** Host-resolved account labels can include a bounded, safe subtitle. */
    description?: string;
    disabled?: boolean;
}>;

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
    resolveFieldOptions: (field: EffectiveActionInputField) => readonly ActionFieldOption[];
    onPatch: (patch: Record<string, unknown>) => void;
    resolveFieldTestID?: (field: EffectiveActionInputField) => string | undefined;
    getChipAccessibilityLabel?: (args: Readonly<{
        field: EffectiveActionInputField;
        option: ActionFieldOption;
        selected: boolean;
    }>) => string | undefined;
}>) {
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);

    return (
        <HappierForm busy={props.busy}>
            {props.fields.map((field) => {
                const path = typeof field?.path === 'string' ? field.path : '';
                const widget = typeof field?.widget === 'string' ? field.widget : '';
                if (!path || !widget) return null;

                const label = typeof field?.title === 'string' ? field.title : path;
                const presentation = resolveActionFieldPresentationForInput(field, props.input);
                if (!presentation) return null;
                const disabled = field.disabled === true;
                const fieldTestID = props.resolveFieldTestID?.(field);

                if (presentation.kind === 'select') {
                    const selected = presentation.value;
                    const selectedValues = Array.isArray(selected)
                        ? selected
                        : (selected === undefined ? [] : [selected]);
                    const options: readonly HappierSelectOption<ActionInputOptionValue>[] = props.resolveFieldOptions(field).map((option) => ({
                        ...option,
                        accessibilityLabel: props.getChipAccessibilityLabel?.({
                            field,
                            option,
                            selected: selectedValues.some((value) => isSameActionInputOptionValue(value, option.value)),
                        }),
                    }));
                    return (
                        <HappierField
                            key={path}
                            label={label}
                            description={field.description}
                            required={field.required}
                            disabled={!props.editable || disabled}
                            theme={presentationTheme}
                            style={{ marginTop: 10 }}
                        >
                            <HappierSelect
                                label={label}
                                options={options}
                                value={selected}
                                multiple={presentation.multiple}
                                maxSelections={field.maxSelections}
                                minimumSelections={presentation.multiple && field.required ? 1 : undefined}
                                disabled={!props.editable || disabled}
                                theme={presentationTheme}
                                isEqual={isSameActionInputOptionValue}
                                keyForOption={(option) => actionInputOptionValueKey(option.value)}
                                onChange={(next) => props.onPatch(patchHappierActionInputPath(props.input, path, next))}
                            />
                        </HappierField>
                    );
                }

                if (presentation.kind === 'toggle') {
                    const selected = presentation.value;
                    const accessibilityLabel = props.getChipAccessibilityLabel?.({
                        field,
                        option: { value: String(selected), label },
                        selected,
                    }) ?? label;
                    return (
                        <HappierField
                            key={path}
                            label={label}
                            description={field.description}
                            required={field.required}
                            disabled={!props.editable || disabled}
                            theme={presentationTheme}
                            style={{ marginTop: 10 }}
                        >
                            <HappierToggle
                                label={accessibilityLabel}
                                value={selected}
                                disabled={!props.editable || disabled}
                                theme={presentationTheme}
                                onChange={(next) => props.onPatch(patchHappierActionInputPath(props.input, path, next))}
                            />
                        </HappierField>
                    );
                }

                if (presentation.kind === 'text') {
                    return (
                        <HappierField
                            key={path}
                            label={label}
                            description={field.description}
                            required={field.required}
                            disabled={!props.editable || disabled}
                            theme={presentationTheme}
                            style={{ marginTop: 10 }}
                        >
                            <HappierTextField
                                label={label}
                                testID={fieldTestID}
                                placeholder={field.placeholder}
                                required={field.required}
                                disabled={!props.editable || disabled}
                                value={presentation.value}
                                secure={presentation.secure}
                                keyboardType={presentation.keyboardType}
                                onChangeText={(text) => props.onPatch(
                                    patchHappierActionInputPath(props.input, path, presentation.parseText(text)),
                                )}
                                multiline={presentation.multiline}
                                theme={presentationTheme}
                            />
                        </HappierField>
                    );
                }

                return null;
            })}
        </HappierForm>
    );
}
