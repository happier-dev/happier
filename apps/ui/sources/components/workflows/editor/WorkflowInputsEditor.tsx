import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FIELD_BOX_METRICS } from '@/components/ui/forms/fieldBox';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
    describeWorkflowInputRepair,
    describeWorkflowInputValueType,
} from '@/components/workflows/presentation/workflowBlockedReasonText';

import { WorkflowFieldSelect } from './WorkflowStepDataEditor';
import { workflowEditorStyles } from './workflowEditorStyles';

const styles = StyleSheet.create((theme) => ({
    root: { gap: theme.space.s8 },
    heading: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    title: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary },
    // The section's quiet trailing action ("+ Add input"), on the title's line at its end.
    addTarget: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, paddingHorizontal: theme.space.s4 },
    add: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.secondary },
    row: {
        gap: theme.space.s8,
        paddingVertical: theme.space.s12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    line: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.space.s8 },
    nameField: { flexGrow: 1, flexBasis: 140, minWidth: 0 },
    // Beside its label while a field's own width fits there; beneath it, at the line's width, when it doesn't.
    defaultInput: { flexGrow: 1, flexShrink: 1, flexBasis: FIELD_BOX_METRICS.triggerMinWidthPx, minWidth: 0 },
    required: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    requiredLabel: { ...Typography.variant('label', 'regular'), color: theme.colors.text.primary },
    defaultField: { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s8 },
}));

const VALUE_TYPES = ['string', 'number', 'boolean', 'json'] as const;
const PARTICIPANT_TYPE = 'agentParticipant';
const PARTICIPANT_LIST_TYPE = 'agentParticipantList';

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
    // One input, composed from the page's own field controls (DESIGN-13): its name and type on the
    // first line, what it is for beneath, then whether a run must supply it (or what it falls back
    // to). No text tabs or link-coloured words: a choice is a field select, a yes/no is a switch.
    return (
        <View testID={rowId} style={styles.row} accessibilityRole="summary">
            <View style={styles.line}>
                <View style={styles.nameField}>
                    <FieldTextInput
                        testID={`${rowId}-name`}
                        value={input.name}
                        monospace
                        placeholder={t('workflows.inputs.namePlaceholder')}
                        accessibilityLabel={t('workflows.inputs.namePlaceholder')}
                        onChangeText={(name) => props.onChange({ ...input, name })}
                    />
                </View>
                <WorkflowFieldSelect
                    testID={`${rowId}-type`}
                    label={t('workflows.inputs.typeLabel')}
                    items={[
                        ...VALUE_TYPES.map((valueType) => ({
                            id: valueType, testID: `${rowId}-type-${valueType}`, title: describeWorkflowInputValueType(valueType),
                        })),
                        { id: PARTICIPANT_TYPE, testID: `${rowId}-type-${PARTICIPANT_TYPE}`,
                            title: t('workflows.inputs.typeParticipant') },
                        { id: PARTICIPANT_LIST_TYPE, testID: `${rowId}-type-${PARTICIPANT_LIST_TYPE}`,
                            title: t('workflows.inputs.typeParticipants') },
                    ]}
                    selectedId={input.inputType && 'hostType' in input.inputType && input.inputType.hostType === 'agentParticipant'
                        ? input.multiple ? PARTICIPANT_LIST_TYPE : PARTICIPANT_TYPE : input.valueType}
                    onSelect={(id) => {
                        if (id === PARTICIPANT_TYPE || id === PARTICIPANT_LIST_TYPE) {
                            const { inputType: _inputType, multiple: _multiple, enum: _enum,
                                optionsSourceId: _optionsSourceId, default: _default, defaultFrom: _defaultFrom, ...base } = input;
                            setDefaultText('');
                            props.onChange({ ...base, valueType: 'json', inputType: { hostType: 'agentParticipant' },
                                ...(id === PARTICIPANT_LIST_TYPE ? { multiple: true } : {}) });
                            return;
                        }
                        const valueType = VALUE_TYPES.find((candidate) => candidate === id);
                        if (valueType === undefined) return;
                        const nextDefault = parseDefault(valueType, defaultText);
                        const { inputType: _inputType, multiple: _multiple, defaultFrom: _defaultFrom, ...base } = input;
                        props.onChange({
                            ...base,
                            valueType,
                            ...(nextDefault === undefined ? { default: undefined } : { default: nextDefault }),
                        });
                    }}
                />
                {/* Removing an input is a quiet trailing icon on its name line, not a red word on every row. */}
                <IconButton
                    testID={`${rowId}-remove`}
                    iconName="trash"
                    variant="plain"
                    accessibilityLabel={t('workflows.editor.remove')}
                    tooltip={t('workflows.editor.remove')}
                    onPress={props.onRemove}
                />
            </View>
            <FieldTextInput
                testID={`${rowId}-description`}
                value={input.description ?? ''}
                placeholder={t('workflows.inputs.descriptionPlaceholder')}
                accessibilityLabel={t('workflows.inputs.descriptionPlaceholder')}
                onChangeText={(description) => props.onChange({
                    ...input,
                    ...(description.length === 0 ? { description: undefined } : { description }),
                })}
            />
            <View style={styles.line}>
                <View style={styles.required}>
                    <Text style={styles.requiredLabel}>{t('workflows.inputs.required')}</Text>
                    <Switch
                        testID={`${rowId}-required`}
                        accessibilityLabel={t('workflows.inputs.required')}
                        value={input.required}
                        onValueChange={(required) => props.onChange(required
                            ? { ...input, required: true, default: undefined }
                            : { ...input, required: false })}
                    />
                </View>
                {input.required ? null : (
                    // An optional input names what it falls back to, so a filled default never reads as an unlabelled value.
                    <View style={styles.defaultField}>
                        <Text style={styles.requiredLabel}>{t('workflows.inputs.defaultValue')}</Text>
                        <FieldTextInput
                            style={styles.defaultInput}
                            testID={`${rowId}-default`}
                            value={defaultText}
                            placeholder={t('workflows.inputs.defaultValue')}
                            accessibilityLabel={t('workflows.inputs.defaultValue')}
                            // The repair reaches assistive technology on the field itself, and is
                            // shown under it by the field's own error slot.
                            error={defaultInvalid ? describeWorkflowInputRepair({
                                valueType: input.valueType,
                                errorCode: 'invalid_input',
                            }) : null}
                            onChangeText={(text) => {
                                setDefaultText(text);
                                const value = parseDefault(input.valueType, text);
                                props.onChange({ ...input, ...(value === undefined ? { default: undefined } : { default: value }) });
                            }}
                        />
                    </View>
                )}
            </View>
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
                    style={(state) => [workflowEditorStyles.actionTarget, styles.addTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                >
                    <Icon name="plus" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
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
