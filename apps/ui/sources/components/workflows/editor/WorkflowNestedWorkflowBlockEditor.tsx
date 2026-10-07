import * as React from 'react';
import { View } from 'react-native';

import type { WorkflowNestedLeafV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';
import type { WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { projectWorkflowRunInputFields } from '@/sync/domains/workflows/workflowAuthoring';
import { useWorkflowReferenceDefinition } from '@/components/workflows/presentation/useWorkflowReferenceDefinition';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

import { Text } from '@/components/ui/text/Text';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';

import type { WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { WorkflowBlockHeading, type WorkflowBlockNameEditor } from './WorkflowBlockHeading';
import { Icon } from '@/components/ui/icons/Icon';
import { formatWorkflowConditionSentence } from './WorkflowConditionEditor';
import { WorkflowContainerSummary } from './WorkflowContainerSummary';
import type { WorkflowDocumentStepSlots } from './workflowDocumentPresentation';
import {
    listBuiltinWorkflowReferenceOptions,
    useWorkflowReferenceLibrary,
} from '@/components/workflows/presentation/workflowReferenceOptions';

import { workflowEditorStyles } from './workflowEditorStyles';
import { formatWorkflowFieldLabel, formatWorkflowValueReference, WorkflowValueReferenceEditor } from './WorkflowStepDataEditor';

/**
 * A Run a workflow step (U4, 04 §4.3): the child named with its origin, "Runs
 * another workflow · its steps show in this run", and its declared inputs as
 * rows bound by reference. Inputs already bound but not declared (a child this
 * client cannot read, or one that changed) stay visible.
 */
export function WorkflowNestedWorkflowBlockEditor(props: Readonly<{
    block: WorkflowNestedLeafV1;
    draft: WorkflowEditorDraft;
    ordinal: number;
    nameEditor?: WorkflowBlockNameEditor;
    total: number;
    actions: readonly WorkflowBlockAction[];
    onSelect: () => void;
    onChangeBlock: (next: WorkflowNestedLeafV1) => void;
    editable?: boolean;
    slots?: WorkflowDocumentStepSlots | null;
    /** Opens this block's Step options, anchored beside its options control; absent when read-only. */
    onOpenOptions?: (anchorRef: React.RefObject<View | null>) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { block, testIDPrefix } = props;
    const { theme } = useUnistyles();
    const editable = props.editable !== false;
    const frozen = props.slots?.nestedDefinition;
    const library = useWorkflowReferenceLibrary({ enabled: frozen === undefined });
    const libraryOptions = library.options;
    const known = [...listBuiltinWorkflowReferenceOptions(), ...libraryOptions]
        .find((option) => option.ref === block.workflowRef) ?? null;
    const childName = known?.title ?? t('workflows.page.blocks.menuRun');
    const displayName = workflowBlockReferenceLabel(block, childName);
    const child = useWorkflowReferenceDefinition(frozen === undefined ? block.workflowRef : null, frozen === undefined);
    const definition = frozen === undefined ? child.definition : frozen;
    const declared = React.useMemo(() => definition === null ? null
        : projectWorkflowRunInputFields({ inputs: definition.inputs, values: {} }).map((field) => field.definition), [definition]);
    const inputNames = React.useMemo(() => {
        const names = (declared ?? []).map((input) => input.name);
        for (const name of Object.keys(block.input)) if (!names.includes(name)) names.push(name);
        return names;
    }, [block.input, declared]);
    const rowPrefix = `${testIDPrefix}-workflow-${block.id}`;

    const setBinding = (name: string, binding: WorkflowValueReference | undefined) => {
        const { [name]: _previous, ...rest } = block.input;
        props.onChangeBlock({ ...block, input: binding === undefined ? rest : { ...rest, [name]: binding } });
    };

    return (
        <View testID={rowPrefix} style={workflowEditorStyles.blockBody}>
            <WorkflowBlockHeading
                nameEditor={props.nameEditor}
                kindMark={<Icon name="tree-structure" size={16} />}
                ordinal={props.ordinal}
                displayName={displayName}
                accessibilityLabel={t('workflows.a11y.stepContext', { block: displayName, position: props.ordinal, total: props.total })}
                actions={editable ? props.actions : []}
                accessory={props.slots?.state}
                onSelect={props.onSelect}
                testID={`${rowPrefix}-label`}
                actionsTestID={`${rowPrefix}-actions`}
            />
            <Text style={workflowEditorStyles.headingName}>{known?.origin === 'builtin' ? `${childName} · ${t('workflows.page.blocks.builtin')}` : childName}</Text>
            {props.slots?.occurrenceSelector ?? null}
            {props.onOpenOptions === undefined || props.editable === false ? null : (
                <WorkflowContainerSummary
                    sentence={props.block.onlyWhen === undefined
                        ? t('workflows.page.inspector.stepOptions')
                        : t('workflows.page.inspector.onlyWhenSentence', {
                            condition: formatWorkflowConditionSentence(props.draft, props.block.onlyWhen),
                        })}
                    onOpenOptions={props.onOpenOptions}
                    optionsLabel={t('workflows.page.inspector.stepOptions')}
                    testID={`${rowPrefix}-options`}
                />
            )}
            <Text style={workflowEditorStyles.metaText}>{t('workflows.page.blocks.workflowSub')}</Text>
            {child.status === 'loading' ? <Text>{t('common.loading')}</Text> : null}
            {child.status === 'failed' ? <View style={workflowEditorStyles.metaRow}>
                <Text accessibilityRole="alert" style={workflowEditorStyles.metaText}>{t('workflows.editor.loadFailedBody')}</Text>
                <HappierPressable accessibilityRole="button" testID={`${rowPrefix}-retry`}
                    accessibilityLabel={t('workflows.page.blocks.retryLoading')}
                    style={(state) => [workflowEditorStyles.actionTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    onPress={child.retry}>
                    <Text style={workflowEditorStyles.metaAction}>{t('workflows.page.blocks.retryLoading')}</Text>
                </HappierPressable>
            </View> : null}
            {frozen === null ? <Text style={workflowEditorStyles.metaText}>{t('workflows.contentUnavailable')}</Text> : null}
            {inputNames.length === 0 && declared === null && child.status !== 'failed' && frozen !== null ? (
                <Text style={workflowEditorStyles.groupSummary}>
                    {t('workflows.page.blocks.childInputs', { workflow: displayName })}
                </Text>
            ) : null}
            {inputNames.map((name) => {
                const binding = block.input[name];
                const declaration = declared?.find((input) => input.name === name);
                const fieldId = `${rowPrefix}-input-${name}`;
                return (
                    <View key={name} testID={fieldId} style={workflowEditorStyles.actionFieldRow}>
                        <View style={workflowEditorStyles.metaRow}>
                            <Text style={workflowEditorStyles.actionFieldLabel}>{formatWorkflowFieldLabel(name)}</Text>
                            {declaration?.required === true ? (
                                <Text style={workflowEditorStyles.groupSummary}>{t('workflows.page.blocks.required')}</Text>
                            ) : null}
                        </View>
                        {!editable ? <Text style={workflowEditorStyles.metaText}>
                            {binding === undefined ? t('workflows.page.blocks.notSet') : formatWorkflowValueReference(props.draft, binding)}
                        </Text> : <WorkflowValueReferenceEditor
                            reference={binding ?? { kind: 'literal', value: '' }}
                            index={0}
                            draft={props.draft}
                            stepId={block.id}
                            onChange={(next) => setBinding(name, next)}
                            {...(binding === undefined || !editable || declaration?.required === true
                                ? {}
                                : { onRemove: () => setBinding(name, undefined) })}
                            testIDPrefix={fieldId}
                        />}
                    </View>
                );
            })}
            {props.slots?.reviewedCard ?? null}
            {props.slots?.footer ?? null}
        </View>
    );
}
