import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, HappierPressable } from '@happier-dev/plugin-ui/presentation';

import type { WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text, TextInput } from '@/components/ui/text/Text';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import type { WorkflowConditionValueFacts } from '../presentation/workflowConditionRules';
import { formatWorkflowValueReference } from '../presentation/workflowValuePresentation';
import {
    listWorkflowConditionValueOptions,
    resolveWorkflowConditionValueFacts,
    workflowValueIsDeclaredField,
} from './workflowConditionValueOptions';
import { workflowEditorStyles } from './workflowEditorStyles';

const FIXED_VALUE = '$fixed';

/** One field-path parser for input and result bindings, including the workflow's final result. */
function parseWorkflowFieldPath(value: string): (string | number)[] {
    return value.trim().length === 0 ? []
        : value.split('.').filter(Boolean).map(part => /^(0|[1-9][0-9]*)$/u.test(part) ? Number(part) : part);
}

export function WorkflowReferenceRawPathInput<Reference extends Extract<WorkflowValueReference, { kind: 'result' | 'input' }>>(props: Readonly<{
    reference: Reference;
    onChange: (reference: Reference) => void;
    testID: string;
    style?: React.ComponentProps<typeof TextInput>['style'];
}>): React.ReactElement {
    const sourceIdentity = props.reference.kind === 'result' ? props.reference.producer : props.reference.name;
    const source = JSON.stringify([sourceIdentity, props.reference.path ?? []]);
    const pathText = (props.reference.path ?? []).join('.');
    const [buffer, setBuffer] = React.useState({ source, value: pathText });
    React.useEffect(() => {
        setBuffer(current => current.source === source ? current : { source, value: pathText });
    }, [source, pathText]);
    return <TextInput
        testID={props.testID}
        style={props.style ?? workflowEditorStyles.inlineValue}
        value={buffer.value}
        autoCapitalize="none" autoCorrect={false}
        accessibilityLabel={t('workflows.finalOutput.fieldPath')}
        placeholder={t('workflows.finalOutput.fieldPath')}
        onChangeText={(value) => {
            const path = parseWorkflowFieldPath(value);
            setBuffer({ source: JSON.stringify([sourceIdentity, path]), value });
            props.onChange({ ...props.reference, path });
        }}
    />;
}

/**
 * Choosing a value: one searchable list of everything this block can read, by name and type, grouped
 * by where it comes from. The reference's kind, producer and field are this list's concern, never
 * separate selects. Conditions, step inputs and Action fields all choose through it.
 *
 * Its trigger reads as the reference token the document shows, so the control and the sentence it
 * produces look like the same thing. A value inside untyped JSON stays reachable through the path
 * field it opens beside itself.
 */
export function WorkflowValuePicker(props: Readonly<{
    draft: WorkflowEditorDraft;
    consumerBlockId: string;
    continuation?: boolean;
    /** `null`: nothing is chosen yet. */
    reference: WorkflowValueReference | null;
    label: string;
    onChange: (reference: WorkflowValueReference, facts: WorkflowConditionValueFacts) => void;
    /** Offers typing a value in as the list's last choice. */
    onChooseFixedValue?: () => void;
    /** Offers only the typed value: the consuming field's contract accepts nothing else. */
    fixedOnly?: boolean;
    /** Replaces the token, for a quiet entry beside a typed value. */
    renderTrigger?: (control: Readonly<{ toggle: () => void }>) => React.ReactNode;
    testID: string;
    pathTestID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const [pathOpen, setPathOpen] = React.useState(false);
    const { draft, consumerBlockId, continuation, reference, fixedOnly } = props;
    const options = React.useMemo(() => fixedOnly === true ? [] : listWorkflowConditionValueOptions(draft, consumerBlockId,
        continuation === true ? { continuation: true } : undefined), [consumerBlockId, continuation, draft, fixedOnly]);
    const fixed = reference?.kind === 'literal' && props.onChooseFixedValue !== undefined;
    const selectedId = reference === null ? null : fixed ? FIXED_VALUE : JSON.stringify(reference);
    const label = reference === null ? t('workflows.condition.chooseValue')
        : fixed ? t('workflows.condition.fixedValue') : formatWorkflowValueReference(draft, reference);
    const token = reference !== null && !fixed;
    const pathReference = reference !== null && (reference.kind === 'result' || reference.kind === 'input')
        && (pathOpen || (reference.path?.length ?? 0) > 0 || (reference.kind === 'input' && draft.inputs.find((input) => input.name === reference.name)?.valueType === 'json'))
        && !workflowValueIsDeclaredField(draft, reference)
        ? reference as Extract<WorkflowValueReference, { kind: 'result' | 'input' }> : null;
    return (
        <>
            <View style={workflowEditorStyles.referenceSelect}>
                <DropdownMenu
                    testID={props.testID}
                    open={open}
                    onOpenChange={setOpen}
                    search
                    searchPlaceholder={t('workflows.condition.findValue')}
                    showCategoryTitles
                    matchTriggerWidth={false}
                    selectedId={selectedId}
                    items={[
                        ...options.map((option) => ({
                            id: option.id,
                            title: option.title,
                            category: option.category,
                            testID: `${props.testID}-option-${option.id}`,
                            ...(option.typeLabel === null ? {} : { rightElement: <Text style={workflowEditorStyles.metaText}>{option.typeLabel}</Text> }),
                        })),
                        ...(props.onChooseFixedValue === undefined ? [] : [{ id: FIXED_VALUE, title: t('workflows.condition.fixedValue'), testID: `${props.testID}-option-fixed` }]),
                    ]}
                    onSelect={(id) => {
                        setOpen(false);
                        if (id === FIXED_VALUE) { setPathOpen(false); props.onChooseFixedValue?.(); return; }
                        const option = options.find((candidate) => candidate.id === id);
                        if (option === undefined) return;
                        setPathOpen(option.opensPath === true);
                        props.onChange(option.reference, option.facts);
                    }}
                    trigger={({ toggle }) => props.renderTrigger !== undefined ? props.renderTrigger({ toggle }) : (
                        <HappierPressable
                            testID={`${props.testID}-trigger`}
                            accessibilityRole="button"
                            accessibilityLabel={`${props.label}: ${label}`}
                            hasPopup="menu"
                            expanded={open}
                            onPress={toggle}
                            style={HAPPIER_FOCUS_RING_DELEGATED_STYLE}
                        >
                            {(state) => (
                                <View style={[
                                    workflowEditorStyles.valuePicker,
                                    token ? { backgroundColor: theme.colors.state.active.background } : workflowEditorStyles.valuePickerUnset,
                                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                                ]}>
                                    <Text numberOfLines={1} style={[workflowEditorStyles.valuePickerLabel,
                                        { color: token ? theme.colors.state.active.foreground : theme.colors.text.secondary }]}>
                                        {token ? `↵ ${label}` : label}
                                    </Text>
                                    <Icon name={open ? 'caret-up' : 'caret-down'} size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                                </View>
                            )}
                        </HappierPressable>
                    )}
                />
            </View>
            {pathReference === null || props.pathTestID === undefined ? null : (
                <WorkflowReferenceRawPathInput
                    testID={props.pathTestID}
                    style={[workflowEditorStyles.inlineValue, workflowEditorStyles.pathValue]}
                    reference={pathReference}
                    onChange={(next) => props.onChange(next, resolveWorkflowConditionValueFacts(draft, next))}
                />
            )}
        </>
    );
}
