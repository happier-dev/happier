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
import { isWorkflowActionLiteralFieldV1 } from '@happier-dev/protocol/workflows/stepActionsV1';
import { workflowInputToFieldHint } from '@happier-dev/protocol/workflows/workflowV1';

import { ActionInputFields, formatActionInputFieldChoice } from '@/components/sessions/actions/ActionInputFields';
import { findWorkflowActionSpec } from '@/components/workflows/presentation/workflowActionCatalog';
import type { ResolveSessionActionFieldOptions } from '@/components/sessions/actions/sessionActionFieldOptions';
import { Text } from '@/components/ui/text/Text';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '@/components/workflows/presentation/workflowBlockKindGlyph';
import { resolvePluginContributedActionIconName } from '@/components/plugins/actions/pluginContributedActionPresentation';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';
import { resolveWorkflowUnnamedHeading, workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';

import type { WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { WorkflowBlockHeading, type WorkflowBlockNameEditor } from './WorkflowBlockHeading';
import { formatWorkflowBlockOptionsSummary, WorkflowStepOptionsFootChip } from './WorkflowStepOptionsChip';
import type { WorkflowDocumentStepSlots } from './workflowDocumentPresentation';
import { workflowEditorStyles } from './workflowEditorStyles';
import { WorkflowKindCard } from './WorkflowKindCard';
import { formatWorkflowExecutionLiteral, formatWorkflowFieldLabel } from '../presentation/workflowValuePresentation';
import { WorkflowBindingRow, WorkflowValueReferenceEditor } from './WorkflowStepDataEditor';

const NO_ROWS: readonly ActionFieldRow[] = Object.freeze([]);

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
            label: field.prompt ?? formatWorkflowFieldLabel(field.path, field.title),
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
    referenceLabels?: Readonly<Record<string, readonly string[]>>;
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
    const fieldOptions = useInputFieldOptions({ machineId: catalog.machineId, sessionId: catalog.sessionId, serverId: catalog.serverId,
        enabled: editable && spec !== null && spec.projectionError === undefined,
        requests: rows.flatMap((row) => row.hint ? [{ field: row.hint, actionId: block.actionId, draftInput: literalInput }] : []) });
    const resolveFieldOptions = parseQualifiedPluginActionId(block.actionId) ? fieldOptions.resolveOptions
        : props.resolveFieldOptions ?? fieldOptions.resolveOptions;
    const actionTitle = spec?.title ?? t('workflows.page.blocks.menuAction');
    const displayName = workflowBlockReferenceLabel(block, actionTitle);
    const rowPrefix = `${testIDPrefix}-action-${block.id}`;
    const actionGlyph = spec?.plugin ? resolvePluginContributedActionIconName(spec.plugin.icon) : WORKFLOW_BLOCK_KIND_GLYPH.action;
    // Unnamed, the heading carries the card's identity and the card shows only its rows.
    const headingCarriesCard = resolveWorkflowUnnamedHeading(block) === 'card';
    const actionSource = spec?.plugin?.title ?? (spec === null ? t('workflows.page.blocks.actionNotInCatalog') : 'Happier');
    const optionsSummary = formatWorkflowBlockOptionsSummary(block);

    // At rest, fields the workflow fills from its inputs read as one line; selecting the step opens them.
    const askedRows = props.selected === true ? NO_ROWS : rows.filter((row) =>
        block.input[row.key]?.kind === 'input' && props.fieldIssues?.[row.key] === undefined);
    const listedRows = askedRows.length === 0 ? rows : rows.filter((row) => !askedRows.includes(row));
    // Settings disclose progressively (owner 2026-11-06, lab round 1106 F1): what is set, required or
    // in need of repair stays; an option nobody set waits behind one "N more settings" until asked for.
    // A reader never sees unset fields at all (`WorkflowBindingRow`), so this is the editor's alone.
    const [allSettingsShown, setAllSettingsShown] = React.useState(false);
    const quietRows = !editable || allSettingsShown ? NO_ROWS : listedRows.filter((row) =>
        block.input[row.key] === undefined && !row.required && props.fieldIssues?.[row.key] === undefined);
    const shownRows = quietRows.length === 0 ? listedRows : listedRows.filter((row) => !quietRows.includes(row));
    const askedLine = askedRows.length === 0 ? null : t('workflows.page.blocks.asksWhenItRuns', {
        names: [...new Set(askedRows.flatMap((row) => {
            const binding = block.input[row.key];
            if (binding?.kind !== 'input') return [];
            // The same words as the page's "Asks when it runs" row and Workflow settings.
            const declared = props.draft.inputs.find((input) => input.name === binding.name);
            return [formatWorkflowFieldLabel(binding.name, declared ? workflowInputToFieldHint(declared).title : undefined)];
        }))].join(', '),
    });

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
                        label={optionsSummary.label}
                        changed={optionsSummary.changed}
                        onOpen={props.onOpenOptions}
                        testID={`${rowPrefix}-options`}
                        labelTestID={`${rowPrefix}-options-label`}
                    />
                )}
            >
            {spec?.projectionError ? <Text testID={`${rowPrefix}-projection-error`} accessibilityRole="alert"
                style={workflowEditorStyles.groupSummary}>{t('workflows.page.blocks.actionUnavailable', { action: displayName })}</Text> : rows.length === 0 ? (
                <Text style={workflowEditorStyles.groupSummary}>{t('workflows.page.blocks.noFields')}</Text>
            ) : <>{askedLine === null ? null : editable ? (
                <HappierPressable testID={`${rowPrefix}-asks`} accessibilityRole="button" accessibilityLabel={askedLine}
                    onPress={props.onSelect} style={workflowEditorStyles.actionFieldRow}>
                    <Text style={workflowEditorStyles.groupSummary}>{askedLine}</Text>
                </HappierPressable>
            ) : (
                <View testID={`${rowPrefix}-asks`} style={workflowEditorStyles.actionFieldRow}>
                    <Text style={workflowEditorStyles.groupSummary}>{askedLine}</Text>
                </View>
            )}{shownRows.map((row) => {
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
                        referenceLabels={props.referenceLabels?.[row.key]}
                        draft={props.draft}
                        fieldName={row.key}
                        editable={editable}
                        editing={props.selected === true}
                        onEdit={props.onSelect}
                        {...(props.fieldIssues?.[row.key] === undefined ? {} : { issue: props.fieldIssues[row.key] })}
                        formatLiteral={(value) => {
                            // A declared execution value reads in words even where the spec's
                            // static option label is the wire value (`read_only`).
                            const execution = formatWorkflowExecutionLiteral(value, row.key);
                            if (execution !== null) return execution;
                            if (row.hint === null) return null;
                            return formatActionInputFieldChoice(row.hint, value, resolveFieldOptions);
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
                        ) : binding.kind === 'object' ? Object.entries(binding.fields).map(([key, reference], index) => (
                            <View key={key}>
                                <Text style={workflowEditorStyles.actionFieldLabel}>{key}</Text>
                                <WorkflowValueReferenceEditor
                                    reference={reference as WorkflowValueReference}
                                    index={index}
                                    draft={props.draft}
                                    stepId={block.id}
                                    literalOnly={literalOnly}
                                    onChange={(next) => setBinding(row.key, { kind: 'object', fields: { ...binding.fields, [key]: next } })}
                                    testIDPrefix={`${fieldId}-field-${key}`}
                                />
                            </View>
                        )) : (
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
                                            // An empty value well says what goes in it, like the plain value entry (DESIGN-9 N5): a
                                            // typed field asks for a value; a choice keeps its select's own "Choose…" rather than "Type…".
                                            fields={[row.hint === null || row.hint.placeholder !== undefined
                                                || row.hint.widget === 'select' || row.hint.widget === 'multiselect'
                                                ? row.hint as EffectiveActionInputField
                                                : { ...row.hint, placeholder: t('workflows.condition.literalPlaceholder') }]}
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
            })}{quietRows.length === 0 ? null : (
                <HappierPressable testID={`${rowPrefix}-more-settings`} accessibilityRole="button"
                    accessibilityLabel={t('workflows.page.blocks.moreSettings', { count: quietRows.length })}
                    onPress={() => setAllSettingsShown(true)} style={workflowEditorStyles.actionFieldRow}>
                    <View style={workflowEditorStyles.addRow}>
                        <Text style={workflowEditorStyles.footAction}>{t('workflows.page.blocks.moreSettings', { count: quietRows.length })}</Text>
                        <Icon name="caret-down" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
                    </View>
                </HappierPressable>
            )}</>}
            </WorkflowKindCard>
            {props.slots?.reviewedCard ?? null}
            {props.slots?.footer ?? null}
        </View>
    );
}
