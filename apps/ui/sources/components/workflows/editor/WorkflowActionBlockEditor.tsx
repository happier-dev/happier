import * as React from 'react';
import { View } from 'react-native';

import type { WorkflowActionSpec } from '@/components/workflows/presentation/workflowActionCatalog';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { useWorkflowActionCatalog } from '@/components/workflows/presentation/useWorkflowActionCatalog';
import type { AuthoringComposerScope } from '@/components/sessions/authoring/ScopedAuthoringComposer';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/actions';
import type { EffectiveActionInputField } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { WorkflowActionFieldBindingV1, WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';
import type { WorkflowCondition, WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { isWorkflowActionLiteralFieldV1 } from '@happier-dev/protocol/workflows/stepActionsV1';
import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { findWorkflowActionSpec } from '@/components/workflows/presentation/workflowActionCatalog';
import type { ResolveSessionActionFieldOptions } from '@/components/sessions/actions/sessionActionFieldOptions';
import { Text } from '@/components/ui/text/Text';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '@/components/workflows/presentation/workflowBlockKindGlyph';
import { resolvePluginContributedActionIconName } from '@/components/plugins/actions/pluginContributedActionPresentation';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';
import { resolveWorkflowUnnamedHeading, workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { listWorkflowProducerOptions } from '@/sync/domains/workflows/workflowAuthoring';

import type { WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { WorkflowBlockHeading, type WorkflowBlockNameEditor } from './WorkflowBlockHeading';
import { formatWorkflowConditionSentence } from './WorkflowConditionEditor';
import { WorkflowStepOptionsFootChip } from './WorkflowStepOptionsChip';
import type { WorkflowDocumentStepSlots } from './workflowDocumentPresentation';
import { workflowEditorStyles } from './workflowEditorStyles';
import { WorkflowKindCard } from './WorkflowKindCard';
import { formatWorkflowFieldLabel, WorkflowBindingRow, WorkflowValueReferenceEditor } from './WorkflowStepDataEditor';

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
            label: formatWorkflowFieldLabel(field.path, field.title),
            ...(field.description === undefined ? {} : { description: field.description }),
            required: field.required === true,
            hint: { ...field, title: formatWorkflowFieldLabel(field.path, field.title) },
        });
    }
    for (const key of Object.keys(input)) {
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ key, label: formatWorkflowFieldLabel(key), required: false, hint: null });
    }
    return rows;
}

/** The exact text result uses '' for a completed Agent turn with no final text. */
function notifyReportCondition(draft: WorkflowEditorDraft, block: WorkflowActionLeafV1): WorkflowCondition | null {
    const message = block.input.message;
    if (message?.kind !== 'result' || message.path.length !== 0) return null;
    const source = findWorkflowBlock(draft, message.producer.blockId);
    if (source?.kind !== 'step' || source.result.kind !== 'text') return null;
    if (!listWorkflowProducerOptions(draft, block.id).some(option => (
        !option.isBranch && option.blockId === message.producer.blockId
        && sameStrictJsonValue(option.scope, message.producer.scope)
    ))) return null;
    return { kind: 'compare', operator: 'neq', left: message, right: { kind: 'literal', value: '' } };
}

function hasNotifyReportCondition(condition: WorkflowCondition | undefined, report: WorkflowCondition): boolean {
    return sameStrictJsonValue(condition, report)
        || (condition?.kind === 'all' && condition.conditions.some(part => sameStrictJsonValue(part, report)));
}

/** Only this conjunct changes; independently authored conditions retain their exact shape. */
function setNotifyReportCondition(condition: WorkflowCondition | undefined, report: WorkflowCondition, enabled: boolean): WorkflowCondition | undefined {
    if (enabled) return hasNotifyReportCondition(condition, report) ? condition
        : condition === undefined ? report : { kind: 'all', conditions: [condition, report] };
    if (sameStrictJsonValue(condition, report)) return undefined;
    if (condition?.kind !== 'all') return condition;
    const remaining = condition.conditions.filter(part => !sameStrictJsonValue(part, report));
    return remaining.length === condition.conditions.length ? condition
        : remaining.length === 0 ? undefined : remaining.length === 1 ? remaining[0] : { ...condition, conditions: remaining };
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
    /** The block's visible number (`workflowBlockOrdinalV1`); `null` for a container. */
    visibleOrdinal?: string | null;
    /** Whether this step is the selected block: its ordinal fills. */
    selected?: boolean;
    nameEditor?: WorkflowBlockNameEditor;
    total: number;
    actions: readonly WorkflowBlockAction[];
    onSelect: () => void;
    onChangeBlock: (next: WorkflowActionLeafV1) => void;
    resolveFieldOptions?: ResolveSessionActionFieldOptions;
    composerScope?: AuthoringComposerScope;
    editable?: boolean;
    /** Registers the block's heading as its focus target (blocks without a prompt). */
    focusRegistration?: (focus: (() => void) | null) => void;
    /** Each field's revealed issue, by field key, in the editor's words (DESIGN-6 P3). */
    fieldIssues?: Readonly<Record<string, string>>;
    slots?: WorkflowDocumentStepSlots | null;
    /** Opens this block's Step options, anchored beside its options control; absent when read-only. */
    onOpenOptions?: (anchorRef: React.RefObject<View | null>) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { block, testIDPrefix } = props;
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
    const actionTitle = spec?.title ?? t('workflows.page.blocks.menuAction');
    const displayName = workflowBlockReferenceLabel(block, actionTitle);
    const rowPrefix = `${testIDPrefix}-action-${block.id}`;
    const actionGlyph = spec?.plugin ? resolvePluginContributedActionIconName(spec.plugin.icon) : WORKFLOW_BLOCK_KIND_GLYPH.action;
    // Unnamed, the heading carries the card's identity and the card shows only its rows.
    const headingCarriesCard = resolveWorkflowUnnamedHeading(block) === 'card';
    const actionSource = spec?.plugin?.title ?? (spec === null ? t('workflows.contentUnavailable') : 'Happier');
    const reportCondition = block.actionId === 'notifications.notify_me' ? notifyReportCondition(props.draft, block) : null;
    const onlyReported = reportCondition !== null && hasNotifyReportCondition(block.onlyWhen, reportCondition);

    const setBinding = (key: string, binding: WorkflowActionFieldBindingV1 | undefined) => {
        const { [key]: _previous, ...rest } = block.input;
        props.onChangeBlock({ ...block, input: binding === undefined ? rest : { ...rest, [key]: binding } });
    };

    return (
        <View testID={rowPrefix} style={workflowEditorStyles.blockBody}>
            {props.slots?.occurrenceSelector ?? null}
            <WorkflowBlockHeading
                nameEditor={props.nameEditor}
                kindMark={<Icon name={actionGlyph} size={ICON_SIZE.sm} />}
                ordinal={props.ordinal}
                selected={props.selected}
                unnamed={resolveWorkflowUnnamedHeading(block)}
                visibleOrdinal={props.visibleOrdinal ?? null}
                {...(props.focusRegistration === undefined ? {} : { focusRegistration: props.focusRegistration })}
                displayName={displayName}
                {...(headingCarriesCard ? { sourceLabel: actionSource } : {})}
                accessibilityLabel={t('workflows.a11y.stepContext', { block: displayName, position: props.ordinal, total: props.total })}
                actions={editable ? props.actions : []}
                accessory={props.slots?.state}
                onSelect={props.onSelect}
                testID={`${rowPrefix}-label`}
                actionsTestID={`${rowPrefix}-actions`}
            />
            <WorkflowKindCard
                testID={`${rowPrefix}-card`}
                mark={<Icon name={actionGlyph} size={ICON_SIZE.sm} />}
                title={actionTitle}
                source={actionSource}
                header={!headingCarriesCard}
                note={spec === null
                    ? t('workflows.page.blocks.actionUnavailable', { action: displayName })
                    : t('workflows.page.blocks.actionSub')}
                footAccessory={props.onOpenOptions === undefined || !editable ? undefined : (
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
            >
            {rows.length === 0 ? (
                <Text style={workflowEditorStyles.groupSummary}>{t('workflows.page.blocks.noFields')}</Text>
            ) : rows.map((row) => {
                const binding = block.input[row.key];
                const fieldId = `${rowPrefix}-field-${row.key}`;
                const literalOnly = isWorkflowActionLiteralFieldV1(block.actionId, row.key);
                return (
                    <WorkflowBindingRow
                        key={row.key}
                        testID={fieldId}
                        label={row.label}
                        required={row.required}
                        {...(literalOnly ? { note: t('workflows.actionTitles.commandValuesInEnv') } : {})}
                        binding={binding}
                        draft={props.draft}
                        fieldName={row.key}
                        editable={editable}
                        editing={props.selected === true}
                        onEdit={props.onSelect}
                        {...(props.fieldIssues?.[row.key] === undefined ? {} : { issue: props.fieldIssues[row.key] })}
                        formatLiteral={(value) => {
                            if (row.hint === null) return null;
                            const options = resolveFieldOptions(row.hint);
                            const label = (item: unknown) => options.find((option) => option.value === item)?.label;
                            const labels = (Array.isArray(value) ? value : [value]).map(label);
                            return labels.length > 0 && labels.every((entry) => entry !== undefined) ? labels.join(', ') : null;
                        }}
                        onSet={() => { setBinding(row.key, initialActionFieldLiteral(row.hint)); props.onSelect(); }}
                        renderEditor={() => binding === undefined ? null : binding.kind === 'list' ? (
                            binding.items.map((item, index) => (
                                <WorkflowValueReferenceEditor
                                    key={index}
                                    reference={item as WorkflowValueReference}
                                    index={index}
                                    draft={props.draft}
                                    stepId={block.id}
                                    literalOnly={literalOnly}
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
                                                frame="none"
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
                                literalOnly={literalOnly}
                                onChange={(next) => setBinding(row.key, next)}
                                {...(row.hint === null || row.hint.widget === 'json' ? {} : {
                                    renderLiteral: (value: unknown, onChange: (next: unknown) => void) => (
                                        <ActionInputFields
                                            // An empty value well says what goes in it, like the plain value entry (DESIGN-9 N5).
                                            fields={[{ ...(row.hint as EffectiveActionInputField),
                                                placeholder: (row.hint as EffectiveActionInputField).placeholder ?? t('workflows.condition.literalPlaceholder') }]}
                                            input={{ [row.key]: value }}
                                            editable={editable}
                                            frame="none"
                                            resolveFieldOptions={resolveFieldOptions}
                                            onPatch={(patch) => onChange(patch[row.key])}
                                            resolveFieldTestID={() => `${fieldId}-literal`}
                                        />
                                    ),
                                })}
                                {...(row.required ? {} : { onRemove: () => setBinding(row.key, undefined) })}
                                testIDPrefix={fieldId}
                            />
                        )}
                    />
                );
            })}
            {block.actionId === 'notifications.notify_me' ? (
                // A card row like the others (label column, then its control), not a list Item with
                // its own inset (DESIGN-7 N5).
                <View testID={`${rowPrefix}-only-reported-row`} style={[workflowEditorStyles.actionFieldRow, workflowEditorStyles.kindCardToggleRow]}>
                    <View style={workflowEditorStyles.kindCardToggleText}>
                        <Text style={workflowEditorStyles.actionFieldText}>{t('sessionWork.scheduled.notifyOnlyReported')}</Text>
                        <Text style={workflowEditorStyles.groupSummary}>{t(reportCondition === null
                            ? 'sessionWork.scheduled.notifyOnlyReportedNeedsResult'
                            : 'sessionWork.scheduled.notifyOnlyReportedDescription')}</Text>
                    </View>
                    <Switch
                        testID={`${rowPrefix}-only-reported`}
                        accessibilityLabel={t('sessionWork.scheduled.notifyOnlyReported')}
                        value={onlyReported}
                        disabled={!editable || reportCondition === null}
                        onValueChange={!editable || reportCondition === null ? undefined : enabled => {
                            const onlyWhen = setNotifyReportCondition(block.onlyWhen, reportCondition, enabled);
                            const { onlyWhen: _previous, ...rest } = block;
                            props.onChangeBlock(onlyWhen === undefined ? rest : { ...rest, onlyWhen });
                        }}
                    />
                </View>
            ) : null}
            </WorkflowKindCard>
            {props.slots?.reviewedCard ?? null}
            {props.slots?.footer ?? null}
        </View>
    );
}
