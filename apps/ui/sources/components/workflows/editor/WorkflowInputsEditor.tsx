import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
    describeWorkflowInputRepair,
    describeWorkflowInputValueType,
} from '@/components/workflows/presentation/workflowBlockedReasonText';

import { workflowEditorStyles } from './workflowEditorStyles';

const styles = StyleSheet.create((theme) => ({
    root: { gap: theme.margins.sm },
    heading: { flexDirection: 'row', alignItems: 'center', gap: theme.margins.sm },
    title: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
    add: { ...Typography.default('semiBold'), color: theme.colors.text.link, marginLeft: 'auto' },
    row: {
        gap: theme.margins.sm,
        paddingVertical: theme.margins.sm,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    line: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.margins.sm },
    input: { ...Typography.default('regular'), color: theme.colors.text.primary, minWidth: 128, flexGrow: 1 },
    description: { ...Typography.default('regular'), color: theme.colors.text.secondary, minWidth: 180, flexGrow: 1 },
    option: { ...Typography.default('regular'), color: theme.colors.text.secondary },
    optionSelected: { ...Typography.default('semiBold'), color: theme.colors.text.link },
    remove: { ...Typography.default('semiBold'), color: theme.colors.text.destructive },
    issue: { ...Typography.default('regular'), color: theme.colors.text.destructive },
}));

const VALUE_TYPES = ['string', 'number', 'boolean', 'json'] as const;

function nextInputName(inputs: readonly WorkflowInputDefinition[]): string {
    const taken = new Set(inputs.map((input) => input.name));
    if (!taken.has('input')) return 'input';
    let ordinal = 2;
    while (taken.has(`input${ordinal}`)) ordinal += 1;
    return `input${ordinal}`;
}

/** A default that is not yet a value of its type is held as the unresolved number the canonical validator rejects. */
function isUnresolvedDefault(value: JsonValue | undefined): boolean {
    return typeof value === 'number' && Number.isNaN(value);
}

function formatDefault(value: JsonValue | undefined): string {
    if (value === undefined || isUnresolvedDefault(value)) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The value the typed text means for the declared type. Empty text is no
 * default. Text that is not a value of that type is kept as the unresolved
 * number rather than dropped or read as another type, so the draft — and every
 * command that consumes its canonical validation — knows the default is not
 * yet usable while the exact text stays visible for repair.
 */
function parseDefault(type: WorkflowInputDefinition['valueType'], text: string): JsonValue | undefined {
    if (text.trim().length === 0) return undefined;
    if (type === 'string') return text;
    if (type === 'number') {
        const value = Number(text);
        return Number.isFinite(value) ? value : Number.NaN;
    }
    if (type === 'boolean') {
        if (text.trim() === 'true') return true;
        if (text.trim() === 'false') return false;
        return Number.NaN;
    }
    try {
        return JSON.parse(text) as JsonValue;
    } catch {
        return Number.NaN;
    }
}

function WorkflowInputRow(props: Readonly<{
    input: WorkflowInputDefinition;
    index: number;
    onChange: (next: WorkflowInputDefinition) => void;
    onRemove: () => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { input } = props;
    const [defaultText, setDefaultText] = React.useState(() => formatDefault(input.default));
    // The draft is the source of truth; the typed text survives only while it
    // still means the draft's default, so an unresolved default keeps the exact
    // text on screen and an external change (undo, reopen) replaces it.
    const defaultTextRef = React.useRef(defaultText);
    defaultTextRef.current = defaultText;
    React.useEffect(() => {
        const meant = parseDefault(input.valueType, defaultTextRef.current);
        const stillMeant = isUnresolvedDefault(meant)
            ? isUnresolvedDefault(input.default)
            : sameStrictJsonValue(meant, input.default);
        if (stillMeant) return;
        setDefaultText(formatDefault(input.default));
    }, [input.default, input.valueType]);
    const defaultInvalid = !input.required && isUnresolvedDefault(input.default);
    const rowId = `${props.testIDPrefix}-input-${props.index}`;
    return (
        <View testID={rowId} style={styles.row} accessibilityRole="summary">
            <View style={styles.line}>
                <TextInput
                    testID={`${rowId}-name`}
                    style={styles.input}
                    value={input.name}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={t('workflows.inputs.namePlaceholder')}
                    accessibilityLabel={t('workflows.inputs.namePlaceholder')}
                    onChangeText={(name) => props.onChange({ ...input, name })}
                />
                {VALUE_TYPES.map((valueType) => (
                    <HappierPressable
                        key={valueType}
                        testID={`${rowId}-type-${valueType}`}
                        accessibilityRole="radio"
                        checked={input.valueType === valueType}
                        onPress={() => {
                            const nextDefault = parseDefault(valueType, defaultText);
                            props.onChange({
                                ...input,
                                valueType,
                                ...(nextDefault === undefined ? { default: undefined } : { default: nextDefault }),
                            });
                        }}
                        style={(state) => [workflowEditorStyles.actionTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        <Text style={input.valueType === valueType ? styles.optionSelected : styles.option}>
                            {describeWorkflowInputValueType(valueType)}
                        </Text>
                    </HappierPressable>
                ))}
            </View>
            <View style={styles.line}>
                <HappierPressable
                    testID={`${rowId}-required`}
                    accessibilityRole="checkbox"
                    checked={input.required}
                    onPress={() => props.onChange(input.required
                        ? { ...input, required: false }
                        : { ...input, required: true, default: undefined })}
                    style={(state) => [workflowEditorStyles.actionTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                >
                    <Text style={input.required ? styles.optionSelected : styles.option}>
                        {input.required ? t('workflows.inputs.required') : t('workflows.inputs.optional')}
                    </Text>
                </HappierPressable>
                <TextInput
                    testID={`${rowId}-description`}
                    style={styles.description}
                    value={input.description ?? ''}
                    placeholder={t('workflows.inputs.descriptionPlaceholder')}
                    accessibilityLabel={t('workflows.inputs.descriptionPlaceholder')}
                    onChangeText={(description) => props.onChange({
                        ...input,
                        ...(description.length === 0 ? { description: undefined } : { description }),
                    })}
                />
                {input.required ? null : (
                    <TextInput
                        testID={`${rowId}-default`}
                        style={styles.input}
                        value={defaultText}
                        autoCapitalize="none"
                        placeholder={t('workflows.inputs.defaultValue')}
                        accessibilityLabel={t('workflows.inputs.defaultValue')}
                        // The repair reaches assistive technology on the field
                        // itself, not only as nearby text.
                        {...(defaultInvalid
                            ? { accessibilityHint: describeWorkflowInputRepair({
                                valueType: input.valueType,
                                errorCode: 'invalid_input',
                            }) ?? undefined }
                            : {})}
                        onChangeText={(text) => {
                            setDefaultText(text);
                            const value = parseDefault(input.valueType, text);
                            props.onChange({ ...input, ...(value === undefined ? { default: undefined } : { default: value }) });
                        }}
                    />
                )}
                <HappierPressable
                    testID={`${rowId}-remove`}
                    accessibilityRole="button"
                    accessibilityLabel={t('workflows.editor.remove')}
                    onPress={props.onRemove}
                    style={(state) => [workflowEditorStyles.actionTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                >
                    <Text style={styles.remove}>{t('workflows.editor.remove')}</Text>
                </HappierPressable>
            </View>
            {defaultInvalid ? (
                <Text
                    testID={`${rowId}-default-error`}
                    accessibilityRole="alert"
                    style={styles.issue}
                >
                    {describeWorkflowInputRepair({
                        valueType: input.valueType,
                        errorCode: 'invalid_input',
                    })}
                </Text>
            ) : null}
        </View>
    );
}

export function WorkflowInputsEditor(props: Readonly<{
    inputs: readonly WorkflowInputDefinition[];
    onChange: (inputs: readonly WorkflowInputDefinition[]) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View testID={`${props.testIDPrefix}-inputs`} style={styles.root}>
            <View style={styles.heading}>
                <Text style={styles.title}>{t('workflows.inputs.title')}</Text>
                <HappierPressable
                    testID={`${props.testIDPrefix}-inputs-add`}
                    accessibilityRole="button"
                    accessibilityLabel={t('workflows.inputs.addInput')}
                    onPress={() => props.onChange([...props.inputs, {
                        name: nextInputName(props.inputs),
                        valueType: 'string',
                        required: false,
                    }])}
                    style={(state) => [workflowEditorStyles.actionTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                >
                    <Text style={styles.add}>{t('workflows.inputs.addInput')}</Text>
                </HappierPressable>
            </View>
            {props.inputs.map((input, index) => (
                <WorkflowInputRow
                    key={index}
                    input={input}
                    index={index}
                    onChange={(next) => props.onChange(props.inputs.map((current, candidate) => (
                        candidate === index ? next : current
                    )))}
                    onRemove={() => props.onChange(props.inputs.filter((_current, candidate) => candidate !== index))}
                    testIDPrefix={props.testIDPrefix}
                />
            ))}
        </View>
    );
}
