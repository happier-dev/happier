import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import type { WorkflowActionSpec } from '@/components/workflows/presentation/workflowActionCatalog';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { useWorkflowActionCatalog } from '@/components/workflows/presentation/useWorkflowActionCatalog';
import type { AuthoringComposerScope } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/actions';
import type { EffectiveActionInputField } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { WorkflowActionFieldBindingV1, WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';
import type { WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';

import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { findWorkflowActionSpec } from '@/components/workflows/presentation/workflowActionCatalog';
import type { ResolveSessionActionFieldOptions } from '@/components/sessions/actions/sessionActionFieldOptions';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import type { WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { WorkflowBlockHeading } from './WorkflowBlockHeading';
import { formatWorkflowConditionSentence } from './WorkflowConditionEditor';
import { WorkflowStepOptionsFootChip } from './WorkflowStepOptionsChip';
import type { WorkflowDocumentStepSlots } from './workflowDocumentPresentation';
import { workflowEditorStyles, workflowPressFeedbackStyle } from './workflowEditorStyles';
import { formatWorkflowValueReference, WorkflowValueReferenceEditor } from './WorkflowStepDataEditor';

/** The literal a newly set field starts from: an empty selection for a multi-select, empty text otherwise. */
function initialActionFieldLiteral(hint: EffectiveActionInputField | null): WorkflowActionFieldBindingV1 {
    return { kind: 'literal', value: hint?.widget === 'multiselect' ? [] : '' };
}

type ActionFieldRow = Readonly<{
    key: string;
    label: string;
    description?: string;
    required: boolean;
    /** The canonical hint, when the Action declares one: it draws a literal with its own widget. */
    hint: EffectiveActionInputField | null;
}>;

/**
 * One row per field of the Action's input: every declared top-level field, then
 * any field already bound that the declaration no longer lists (kept visible,
 * never dropped).
 */
function resolveActionFieldRows(spec: WorkflowActionSpec | null, input: WorkflowActionLeafV1['input']): readonly ActionFieldRow[] {
    const rows: ActionFieldRow[] = [];
    const seen = new Set<string>();
    const literals = Object.fromEntries(Object.entries(input).flatMap(([name, binding]) => binding.kind === 'literal' ? [[name, binding.value]] : []));
    for (const field of spec === null ? [] : resolveEffectiveActionInputFields(spec, literals)) {
        if (field.path.includes('.') || seen.has(field.path)) continue;
        seen.add(field.path);
        rows.push({
            key: field.path,
            label: field.title,
            ...(field.description === undefined ? {} : { description: field.description }),
            required: field.required === true,
            hint: field,
        });
    }
    for (const key of Object.keys(input)) {
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ key, label: key, required: false, hint: null });
    }
    return rows;
}

/**
 * An Action step (U4, 04 §4.3): the Action's name and "No agent turn", then one
 * row per input field, each bound on its own — a literal (drawn with the
 * Action's own field, options from the canonical options sources), a workflow
 * input, an earlier result, or the current item. The binding shape is the
 * leaf's (`WorkflowActionFieldBindingV1`); this owns only its presentation.
 */
export function WorkflowActionBlockEditor(props: Readonly<{
    block: WorkflowActionLeafV1;
    draft: WorkflowEditorDraft;
    ordinal: number;
    total: number;
    actions: readonly WorkflowBlockAction[];
    onSelect: () => void;
    onChangeBlock: (next: WorkflowActionLeafV1) => void;
    resolveFieldOptions?: ResolveSessionActionFieldOptions;
    composerScope?: AuthoringComposerScope;
    editable?: boolean;
    slots?: WorkflowDocumentStepSlots | null;
    /** Opens this block's Step options, anchored beside its options control; absent when read-only. */
    onOpenOptions?: (anchorRef: React.RefObject<View | null>) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { block, testIDPrefix } = props;
    const { theme } = useUnistyles();
    const editable = props.editable !== false;
    const catalog = useWorkflowActionCatalog(props.composerScope);
    const spec = React.useMemo(() => findWorkflowActionSpec(block.actionId, catalog.specs), [block.actionId, catalog.specs]);
    const rows = React.useMemo(() => resolveActionFieldRows(spec, block.input), [block.input, spec]);
    const literalInput = React.useMemo(() => Object.fromEntries(Object.entries(block.input)
        .flatMap(([name, binding]) => binding.kind === 'literal' ? [[name, binding.value]] : [])), [block.input]);
    const fieldOptions = useInputFieldOptions({ machineId: catalog.machineId, serverId: catalog.serverId,
        enabled: editable && spec !== null,
        requests: rows.flatMap((row) => row.hint ? [{ field: row.hint, actionId: block.actionId, draftInput: literalInput }] : []) });
    const resolveFieldOptions = parseQualifiedPluginActionId(block.actionId) ? fieldOptions.resolveOptions
        : props.resolveFieldOptions ?? fieldOptions.resolveOptions;
    const displayName = spec?.title ?? block.actionId;
    const rowPrefix = `${testIDPrefix}-action-${block.id}`;

    const setBinding = (key: string, binding: WorkflowActionFieldBindingV1 | undefined) => {
        const { [key]: _previous, ...rest } = block.input;
        props.onChangeBlock({ ...block, input: binding === undefined ? rest : { ...rest, [key]: binding } });
    };

    return (
        <View testID={rowPrefix} style={workflowEditorStyles.blockBody}>
            <WorkflowBlockHeading
                kindMark={<Icon name="lightning" size={16} />}
                ordinal={props.ordinal}
                displayName={displayName}
                accessibilityLabel={t('workflows.a11y.stepContext', { block: displayName, position: props.ordinal, total: props.total })}
                actions={editable ? props.actions : []}
                accessory={props.slots?.state}
                onSelect={props.onSelect}
                testID={`${rowPrefix}-label`}
                actionsTestID={`${rowPrefix}-actions`}
            />
            {props.slots?.occurrenceSelector ?? null}
            <View testID={`${rowPrefix}-card`} style={workflowEditorStyles.actionCard}>
            {rows.length === 0 ? (
                <Text style={workflowEditorStyles.groupSummary}>{t('workflows.page.blocks.noFields')}</Text>
            ) : rows.map((row) => {
                const binding = block.input[row.key];
                const fieldId = `${rowPrefix}-field-${row.key}`;
                return (
                    <View key={row.key} testID={fieldId} style={workflowEditorStyles.actionFieldRow}>
                        <View style={workflowEditorStyles.actionFieldLabelColumn}>
                            <Text style={workflowEditorStyles.actionFieldLabel}>{row.label}</Text>
                            {row.required ? (
                                <Text style={workflowEditorStyles.groupSummary}>{t('workflows.page.blocks.required')}</Text>
                            ) : null}
                        </View>
                        <View style={workflowEditorStyles.actionFieldValue}>
                        {binding === undefined ? (
                            <View style={workflowEditorStyles.metaRow}>
                                <Text style={workflowEditorStyles.metaText}>{t('workflows.page.blocks.notSet')}</Text>
                                {editable ? (
                                    <HappierPressable
                                        testID={`${fieldId}-set`}
                                        accessibilityRole="button"
                                        accessibilityLabel={`${t('workflows.page.blocks.set')} ${row.label}`}
                                        onPress={() => setBinding(row.key, initialActionFieldLiteral(row.hint))}
                                        style={(state) => [
                                            workflowEditorStyles.actionTarget,
                                            workflowPressFeedbackStyle(state, theme.colors.border.focus),
                                        ]}
                                    >
                                        <Text style={workflowEditorStyles.metaAction}>{t('workflows.page.blocks.set')}</Text>
                                    </HappierPressable>
                                ) : null}
                            </View>
                        ) : !editable ? (
                            <Text style={workflowEditorStyles.metaText} selectable>
                                {(binding.kind === 'list' ? binding.items : [binding]).map((reference) =>
                                    reference.kind === 'origin_session_id'
                                        ? t('workflows.page.inspector.originSession')
                                        : formatWorkflowValueReference(props.draft, reference)).join(' · ')}
                            </Text>
                        ) : binding.kind === 'list' ? (
                            binding.items.map((item, index) => (
                                <WorkflowValueReferenceEditor
                                    key={index}
                                    reference={item as WorkflowValueReference}
                                    index={index}
                                    draft={props.draft}
                                    stepId={block.id}
                                    onChange={(next) => setBinding(row.key, {
                                        kind: 'list',
                                        items: binding.items.map((current, at) => (at === index ? next : current)),
                                    })}
                                    // One list item is one choice from the field's own options source.
                                    {...(row.hint === null || row.hint.widget !== 'multiselect' ? {} : {
                                        renderLiteral: (value: unknown, onChange: (next: unknown) => void) => (
                                            <ActionInputFields
                                                fields={[{ ...(row.hint as EffectiveActionInputField), widget: 'select' }]}
                                                input={{ [row.key]: value }}
                                                editable={editable}
                                                resolveFieldOptions={resolveFieldOptions}
                                                onPatch={(patch) => onChange(patch[row.key])}
                                                resolveFieldTestID={() => `${fieldId}-item-${index}-literal`}
                                            />
                                        ),
                                    })}
                                    testIDPrefix={`${fieldId}-item-${index}`}
                                />
                            ))
                        ) : (
                            <WorkflowValueReferenceEditor
                                reference={binding as WorkflowValueReference}
                                index={0}
                                draft={props.draft}
                                stepId={block.id}
                                onChange={(next) => setBinding(row.key, next)}
                                {...(row.hint === null || row.hint.widget === 'json' ? {} : {
                                    renderLiteral: (value: unknown, onChange: (next: unknown) => void) => (
                                        <ActionInputFields
                                            fields={[row.hint as EffectiveActionInputField]}
                                            input={{ [row.key]: value }}
                                            editable={editable}
                                            resolveFieldOptions={resolveFieldOptions}
                                            onPatch={(patch) => onChange(patch[row.key])}
                                            resolveFieldTestID={() => `${fieldId}-literal`}
                                        />
                                    ),
                                })}
                                {...(!editable || row.required ? {} : { onRemove: () => setBinding(row.key, undefined) })}
                                testIDPrefix={fieldId}
                            />
                        )}
                        </View>
                    </View>
                );
            })}
            <View style={workflowEditorStyles.actionCardFoot}>
                <Text style={workflowEditorStyles.metaText}>
                    {spec === null
                        ? t('workflows.page.blocks.actionUnavailable', { action: block.actionId })
                        : t('workflows.page.blocks.actionSub')}
                </Text>
                {props.onOpenOptions === undefined || !editable ? null : (
                    <WorkflowStepOptionsFootChip
                        label={block.onlyWhen === undefined
                            ? t('workflows.page.blocks.workflowDefaults')
                            : t('workflows.page.inspector.onlyWhenSentence', {
                                condition: formatWorkflowConditionSentence(props.draft, block.onlyWhen),
                            })}
                        changed={block.onlyWhen !== undefined}
                        onOpen={props.onOpenOptions}
                        testID={`${rowPrefix}-options`}
                        labelTestID={`${rowPrefix}-options-label`}
                    />
                )}
            </View>
            </View>
            {props.slots?.reviewedCard ?? null}
            {props.slots?.footer ?? null}
        </View>
    );
}
