import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import type { JsonValue } from '@happier-dev/protocol';
import { parsePermissionIntentAlias } from '@happier-dev/agents/permissions';
import { WorkflowLoopOutcomeV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowAuthoredResultReference, WorkflowReferenceScope, WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import type { WorkflowResultContract, WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';

import { Text, TextInput } from '@/components/ui/text/Text';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import {
    listWorkflowProducerOptions,
    resolveWorkflowReferenceScopeFacts,
} from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { t } from '@/text';
import { workflowFieldTranslations } from '@/text/translations/workflowFieldTranslations';

import { workflowEditorStyles } from './workflowEditorStyles';

type ItemReferenceField = Extract<WorkflowValueReference, { kind: 'item' }>['field'];
type IterationReferenceField = Extract<WorkflowValueReference, { kind: 'iteration' }>['field'];

/** The canonical field vocabulary of each loop-scoped reference kind, in the schema's order. */
const ITEM_REFERENCE_FIELDS: readonly ItemReferenceField[] = ['value', 'index', 'position', 'count'];
const ITERATION_REFERENCE_FIELDS: readonly IterationReferenceField[] = ['index', 'position', 'count', 'stopReason'];

/** The same human field name reads an Action row, a child input and a reference. */
export function formatWorkflowFieldLabel(name: string, title?: string): string {
    if (Object.hasOwn(workflowFieldTranslations.en, name)) {
        return t(`workflows.page.fields.${name as keyof typeof workflowFieldTranslations.en}`);
    }
    // An extension's declared title is presentation metadata; preserve it.
    // Undeclared bindings still need a readable label while staying repairable.
    const label = (title ?? name).replace(/\s*\((?:json|string|number|boolean|object|array)\)\s*$/iu, '').trim()
        .replace(/([a-z\d])([A-Z])/gu, '$1 $2').replace(/[_\-.]+/gu, ' ');
    return label.length === 0 ? t('workflows.input.label') : label[0]!.toLocaleUpperCase() + label.slice(1);
}

function literalText(value: JsonValue): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseLiteral(value: string): JsonValue {
    try { return JSON.parse(value) as JsonValue; } catch { return value; }
}

/** One field-path parser for result bindings, including the workflow's final result. */
function parseWorkflowResultFieldPath(value: string): (string | number)[] {
    return value.trim().length === 0 ? []
        : value.split('.').filter(Boolean).map(part => /^(0|[1-9][0-9]*)$/u.test(part) ? Number(part) : part);
}

/** A result's field path keeps its raw edit ("summary.") while the draft echoes parsed segments. */
export function WorkflowResultFieldPathInput(props: Readonly<{
    reference: WorkflowAuthoredResultReference;
    onChange: (reference: WorkflowAuthoredResultReference) => void;
    testID: string;
    style?: React.ComponentProps<typeof TextInput>['style'];
}>): React.ReactElement {
    const source = JSON.stringify([props.reference.producer, props.reference.path]);
    const pathText = props.reference.path.join('.');
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
            const path = parseWorkflowResultFieldPath(value);
            setBuffer({ source: JSON.stringify([props.reference.producer, path]), value });
            props.onChange({ ...props.reference, path });
        }}
    />;
}

function scopeKey(scope: WorkflowReferenceScope): string {
    if (scope.kind === 'outer') return `outer-${scope.levels}`;
    if (scope.kind === 'previous_iteration') return `previous-${scope.loopBlockId}`;
    return 'current';
}

function scopeLabel(scope: WorkflowReferenceScope): string {
    if (scope.kind === 'outer') return t('workflows.input.scopeOuter', { levels: scope.levels });
    if (scope.kind === 'previous_iteration') return t('workflows.input.scopePreviousIteration');
    return t('workflows.input.scopeCurrent');
}

function referenceKindLabel(kind: WorkflowValueReference['kind']): string {
    if (kind === 'literal') return t('workflows.condition.valuePlaceholder');
    if (kind === 'input') return t('workflows.input.label');
    // A step's result is not the workflow's Final output; only the one root
    // binding is, so the reference kind carries its own name.
    if (kind === 'result') return t('workflows.input.result');
    if (kind === 'workspace') return t('workflows.workspace.title');
    if (kind === 'item') return t('workflows.input.currentItem');
    return t('workflows.input.iteration');
}

/**
 * A reference read as words ("Workflow input files", "Check the build result ·
 * verdict", "Item value"): the one reading Step options sentences, container
 * headings and condition summaries share, so a reference is never worded two
 * ways.
 */
export function formatWorkflowValueReference(draft: WorkflowEditorDraft, reference: WorkflowValueReference, fieldName?: string): string {
    const blockLabel = (blockId: string) => {
        const block = findWorkflowBlock(draft, blockId);
        return block === null ? t('workflows.contentUnavailable') : workflowBlockReferenceLabel(block);
    };
    const withPath = (label: string, path: readonly (string | number)[] | undefined) => (
        path === undefined || path.length === 0 ? label : `${label} · ${path.map(part => typeof part === 'number' ? String(part) : formatWorkflowFieldLabel(part)).join(' · ')}`
    );
    const producerLabel = (producer: Readonly<{ blockId: string; scope: WorkflowReferenceScope }>) => (
        producer.scope.kind === 'current' ? blockLabel(producer.blockId) : `${blockLabel(producer.blockId)} · ${scopeLabel(producer.scope)}`
    );
    switch (reference.kind) {
        case 'literal':
            // Only a declared Action field gives a literal execution meaning.
            // An arbitrary authored string or object must keep its own value.
            if (fieldName === 'target' && reference.value !== null && typeof reference.value === 'object'
                && !Array.isArray(reference.value) && Object.keys(reference.value).length === 1
                && Reflect.get(reference.value, 'kind') === 'detached') return t('workflows.page.sections.aBackgroundRun');
            if (fieldName === 'permissionMode' && typeof reference.value === 'string') {
                const mode = parsePermissionIntentAlias(reference.value);
                if (mode === 'read-only') return t('executionRuns.newRun.permissionModes.readOnly');
                if (mode === 'default') return t('executionRuns.newRun.permissionModes.default');
            }
            return formatWorkflowLiteralValue(reference.value);
        case 'input':
            return t('workflows.input.workflowInput', { name: formatWorkflowFieldLabel(reference.name) });
        case 'result':
            return withPath(t('workflows.input.previousResult', { block: producerLabel(reference.producer) }), reference.path);
        case 'loop_trailing_count':
            return t('workflows.input.trailingCount', {
                source: withPath(t('workflows.input.previousResult', { block: producerLabel(reference.producer) }), reference.path),
                value: formatWorkflowLiteralValue(reference.equals),
            });
        case 'workspace':
            return `${t('workflows.workspace.title')} · ${producerLabel(reference.producer)} · ${t(reference.field === 'directory' ? 'workflows.workspace.projectCheckout' : 'workflows.input.checkoutRoot')}`;
        case 'item':
            return withPath(t(`workflows.input.itemField.${reference.field}`), reference.path);
        case 'iteration':
            return t(`workflows.input.iterationField.${reference.field}`);
        case 'session_context':
            return t('workflows.input.sessionContext', { turns: reference.recentTurns });
        case 'session_context_field':
            return reference.field === 'usage.tokensUsed' ? t('workflows.input.tokensUsed') : t('workflows.input.goalTokenBudget');
        default:
            return t('workflows.input.unavailableValue');
    }
}

/** Literal data is readable too; typed loop outcomes never leak their wire objects. */
function formatWorkflowLiteralValue(value: JsonValue): string {
    const outcome = WorkflowLoopOutcomeV1Schema.safeParse(value);
    if (outcome.success) {
        switch (outcome.data.kind) {
            case 'stop_condition': return outcome.data.arm === undefined ? t('workflows.input.stopCondition')
                : t('workflows.input.stopConditionArm', { arm: outcome.data.arm + 1 });
            case 'exhausted': return t('workflows.input.roundLimit', { rounds: outcome.data.rounds });
            case 'decision': return `${t('workflows.input.decision')} · ${outcome.data.value}${outcome.data.reason ? ` · ${outcome.data.reason}` : ''}`;
        }
    }
    if (typeof value === 'string') return `“${value}”`;
    if (typeof value === 'boolean') return t(value ? 'common.yes' : 'common.no');
    if (value === null) return t('workflows.page.inspector.none');
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.length === 0 ? t('workflows.page.inspector.none') : value.map(formatWorkflowLiteralValue).join(', ');
    const entries = Object.entries(value);
    return entries.length === 0 ? t('workflows.page.inspector.none')
        : entries.map(([name, nested]) => `${formatWorkflowFieldLabel(name)}: ${formatWorkflowLiteralValue(nested)}`).join('; ');
}

/** The document's reference token, including in a loop/condition sentence. */
export function WorkflowValueReferenceToken(props: Readonly<{ draft: WorkflowEditorDraft; reference: WorkflowValueReference; testID?: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    return <Text testID={props.testID} style={{ color: theme.colors.text.link, backgroundColor: theme.colors.surface.elevated,
        borderRadius: theme.borderRadius.sm }} selectable>{`↵ ${formatWorkflowValueReference(props.draft, props.reference)}`}</Text>;
}

/** Keeps the localized sentence intact while its references use the same token owner. */
export function WorkflowReferenceSentence(props: Readonly<{ draft: WorkflowEditorDraft; sentence: string; references: readonly WorkflowValueReference[] }>): React.ReactElement {
    const labels = props.references.map(reference => ({ reference, label: formatWorkflowValueReference(props.draft, reference) }))
        .filter(item => item.label.length > 0).sort((a, b) => b.label.length - a.label.length);
    const parts: React.ReactNode[] = [];
    let offset = 0;
    while (offset < props.sentence.length) {
        const next = labels.map(item => ({ ...item, at: props.sentence.indexOf(item.label, offset) }))
            .filter(item => item.at >= 0).sort((a, b) => a.at - b.at)[0];
        if (!next) { parts.push(props.sentence.slice(offset)); break; }
        parts.push(props.sentence.slice(offset, next.at));
        parts.push(<WorkflowValueReferenceToken key={next.at} draft={props.draft} reference={next.reference} />);
        offset = next.at + next.label.length;
    }
    return <>{parts}</>;
}

/** What a result contract returns, in the footer and in Step options' Result row. */
export function formatWorkflowResultSummary(result: WorkflowResultContract | undefined): string {
    if (result === undefined || result.kind === 'text') return t('workflows.page.blocks.returnsText');
    if (result.kind === 'json') return t('workflows.page.inspector.returnsStructured');
    return t('workflows.page.inspector.returnsDecision');
}

/**
 * A field select for one part of a binding (where its value comes from, which input, which
 * step): the canonical `DropdownMenu` drawn as a field box, so a long list of sources never
 * becomes a row of text tabs that runs past the pane (07 §3 control table).
 */
function ReferenceSelect(props: Readonly<{
    testID: string;
    label: string;
    items: readonly DropdownMenuItem[];
    selectedId: string | null;
    onSelect: (id: string) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const selected = props.items.find((item) => item.id === props.selectedId) ?? null;
    return (
        <View style={workflowEditorStyles.referenceSelect}>
            <DropdownMenu
                testID={props.testID}
                open={open}
                onOpenChange={setOpen}
                items={props.items}
                selectedId={props.selectedId}
                matchTriggerWidth={false}
                onSelect={(id) => { setOpen(false); props.onSelect(id); }}
                trigger={({ toggle }) => (
                    <HappierPressable
                        testID={`${props.testID}-trigger`}
                        accessibilityRole="button"
                        accessibilityLabel={`${props.label}: ${selected?.title ?? ''}`}
                        hasPopup="menu"
                        expanded={open}
                        onPress={toggle}
                    >
                        {(state) => renderDropdownItemTriggerRightElement({
                            detail: typeof selected?.title === 'string' ? selected.title : null,
                            open,
                            detailColor: theme.colors.text.primary,
                            chevronColor: theme.colors.text.secondary,
                            detailDensity: 'compact',
                            field: {
                                ...resolveFieldBoxColors(theme),
                                ...focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                            },
                        })}
                    </HappierPressable>
                )}
            />
        </View>
    );
}

/** One mutually exclusive choice set: a labelled radiogroup row of radio chips. */
function ChoiceGroup(props: Readonly<{
    label: string;
    children: React.ReactNode;
}>): React.ReactElement {
    return (
        <View style={workflowEditorStyles.metaRow} accessibilityRole="radiogroup" accessibilityLabel={props.label}>
            {props.children}
        </View>
    );
}

export function WorkflowValueReferenceEditor(props: Readonly<{
    reference: WorkflowValueReference;
    index: number;
    draft: WorkflowEditorDraft;
    stepId: string;
    /** True for a loop's after-each-round consumer (`stopWhen`), which resolves inside the body. */
    continuation?: boolean;
    onChange: (value: WorkflowValueReference) => void;
    onRemove?: () => void;
    /**
     * Draws a literal value with the consumer's own field (an Action field's
     * options picker), in place of the plain text entry. The binding stays this
     * owner's: the callback receives the literal and reports the next one.
     */
    renderLiteral?: (value: unknown, onChange: (next: unknown) => void) => React.ReactNode;
    testIDPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const rowId = `${props.testIDPrefix}-input-${props.index}`;
    const consumer = props.continuation === true ? { continuation: true } : {};
    const producers = listWorkflowProducerOptions(props.draft, props.stepId, consumer);
    const reference = props.reference;
    const inputName = reference.kind === 'input' ? reference.name : undefined;
    const producerReference = reference.kind === 'result' || reference.kind === 'workspace'
        ? reference
        : undefined;
    const resultReference = reference.kind === 'result' ? reference : undefined;
    const workspaceReference = reference.kind === 'workspace' ? reference : undefined;
    const itemReference = reference.kind === 'item' ? reference : undefined;
    const iterationReference = reference.kind === 'iteration' ? reference : undefined;
    // Loop-scoped kinds are offered only where the canonical validator accepts
    // them; a reference already authored there stays visible for repair.
    const scopeFacts = resolveWorkflowReferenceScopeFacts(props.draft, props.stepId, consumer);
    const kinds = [
        'literal',
        'input',
        'result',
        'workspace',
        ...(scopeFacts.insideItemsLoop || itemReference !== undefined ? ['item' as const] : []),
        ...(scopeFacts.insideLoop || iterationReference !== undefined ? ['iteration' as const] : []),
    ] as const satisfies readonly WorkflowValueReference['kind'][];
    const setKind = (kind: (typeof kinds)[number]): void => {
        if (kind === 'literal') props.onChange({ kind, value: '' });
        else if (kind === 'input') props.onChange({ kind, name: props.draft.inputs[0]?.name ?? 'input' });
        else if (kind === 'result') props.onChange({
            kind,
            producer: producers[0] === undefined
                ? { blockId: props.stepId, scope: { kind: 'current' } }
                : { blockId: producers[0].blockId, scope: producers[0].scope },
            path: [],
        });
        else if (kind === 'workspace') props.onChange({
            kind,
            producer: producers[0] === undefined
                ? { blockId: props.stepId, scope: { kind: 'current' } }
                : { blockId: producers[0].blockId, scope: producers[0].scope },
            field: 'directory',
        });
        else if (kind === 'item') props.onChange({ kind, field: 'value' });
        else props.onChange({ kind, field: 'index' });
    };
    return (
        <View style={workflowEditorStyles.inlineControl}>
            <ReferenceSelect
                testID={`${rowId}-kind`}
                label={t('workflows.input.valueKindGroup')}
                items={kinds.map((kind) => ({ id: kind, testID: `${rowId}-kind-${kind}`, title: referenceKindLabel(kind) }))}
                selectedId={reference.kind}
                onSelect={(id) => {
                    const kind = kinds.find((candidate) => candidate === id);
                    if (kind !== undefined) setKind(kind);
                }}
            />
            {reference.kind === 'literal' && props.renderLiteral !== undefined
                // The consumer's own field sits on the binding's line, like the plain value entry.
                ? <View style={workflowEditorStyles.inlineLiteral}>{props.renderLiteral(reference.value, (next) => props.onChange({
                    kind: 'literal',
                    value: next as Extract<WorkflowValueReference, { kind: 'literal' }>['value'],
                }))}</View>
                : null}
            {reference.kind === 'literal' && props.renderLiteral === undefined ? (
                <TextInput
                    testID={`${rowId}-literal`}
                    style={workflowEditorStyles.inlineValue}
                    value={literalText(reference.value)}
                    accessibilityLabel={t('workflows.condition.valuePlaceholder')}
                    onChangeText={(value) => props.onChange({ kind: 'literal', value: parseLiteral(value) })}
                />
            ) : null}
            {inputName === undefined ? null : (
                <ReferenceSelect
                    testID={`${rowId}-input-name`}
                    label={t('workflows.input.inputNameGroup')}
                    items={props.draft.inputs.map((input) => ({ id: input.name, testID: `${rowId}-input-name-${input.name}`, title: formatWorkflowFieldLabel(input.name) }))}
                    selectedId={inputName}
                    onSelect={(name) => props.onChange({ kind: 'input', name })}
                />
            )}
            {producerReference === undefined ? null : (
                <ReferenceSelect
                    testID={`${rowId}-producer`}
                    label={t('workflows.input.producerGroup')}
                    items={producers.map((producer) => ({
                        id: `${producer.blockId}:${scopeKey(producer.scope)}`,
                        testID: `${rowId}-producer-${producer.blockId}-${scopeKey(producer.scope)}`,
                        title: producer.label,
                        subtitle: scopeLabel(producer.scope),
                    }))}
                    selectedId={`${producerReference.producer.blockId}:${scopeKey(producerReference.producer.scope)}`}
                    onSelect={(id) => {
                        const producer = producers.find((candidate) => `${candidate.blockId}:${scopeKey(candidate.scope)}` === id);
                        if (producer !== undefined) props.onChange({
                            ...producerReference,
                            producer: { blockId: producer.blockId, scope: producer.scope },
                        });
                    }}
                />
            )}
            {resultReference === undefined ? null : (
                <WorkflowResultFieldPathInput
                    testID={`${rowId}-path`}
                    style={[workflowEditorStyles.inlineValue, workflowEditorStyles.pathValue]}
                    reference={resultReference}
                    onChange={props.onChange}
                />
            )}
            {workspaceReference === undefined ? null : (
                <ChoiceGroup label={t('workflows.input.workspaceFieldGroup')}>
                    {(['directory', 'checkoutRootPath'] as const).map((field) => (
                        <HappierPressable
                            key={field}
                            testID={`${rowId}-workspace-field-${field}`}
                            accessibilityRole="radio"
                            checked={workspaceReference.field === field}
                            accessibilityLabel={field === 'directory'
                                ? t('workflows.workspace.title')
                                : t('workflows.workspace.projectCheckout')}
                            onPress={() => props.onChange({ ...workspaceReference, field })}
                            style={(state) => [workflowEditorStyles.actionTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                        >
                            <Text style={workspaceReference.field === field
                                ? workflowEditorStyles.metaAction
                                : workflowEditorStyles.metaText}
                            >{field === 'directory'
                                ? t('workflows.workspace.title')
                                : t('workflows.workspace.projectCheckout')}</Text>
                        </HappierPressable>
                    ))}
                </ChoiceGroup>
            )}
            {itemReference === undefined ? null : (
                <ChoiceGroup label={t('workflows.input.itemFieldGroup')}>
                    {ITEM_REFERENCE_FIELDS.map((field) => (
                        <HappierPressable
                            key={field}
                            testID={`${rowId}-item-field-${field}`}
                            accessibilityRole="radio"
                            checked={itemReference.field === field}
                            accessibilityLabel={t(`workflows.input.itemField.${field}`)}
                            onPress={() => props.onChange({ kind: 'item', field })}
                            style={(state) => [workflowEditorStyles.actionTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                        >
                            <Text style={itemReference.field === field
                                ? workflowEditorStyles.metaAction
                                : workflowEditorStyles.metaText}
                            >{t(`workflows.input.itemField.${field}`)}</Text>
                        </HappierPressable>
                    ))}
                </ChoiceGroup>
            )}
            {iterationReference === undefined ? null : (
                <ChoiceGroup label={t('workflows.input.iterationFieldGroup')}>
                    {ITERATION_REFERENCE_FIELDS.map((field) => (
                        <HappierPressable
                            key={field}
                            testID={`${rowId}-iteration-field-${field}`}
                            accessibilityRole="radio"
                            checked={iterationReference.field === field}
                            accessibilityLabel={t(`workflows.input.iterationField.${field}`)}
                            onPress={() => props.onChange({ kind: 'iteration', field })}
                            style={(state) => [workflowEditorStyles.actionTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                        >
                            <Text style={iterationReference.field === field
                                ? workflowEditorStyles.metaAction
                                : workflowEditorStyles.metaText}
                            >{t(`workflows.input.iterationField.${field}`)}</Text>
                        </HappierPressable>
                    ))}
                </ChoiceGroup>
            )}
            {props.onRemove === undefined ? null : (
                <HappierPressable
                    accessibilityRole="button"
                    onPress={props.onRemove}
                    style={(state) => [workflowEditorStyles.actionTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                >
                    <Text style={workflowEditorStyles.footAction}>{t('workflows.editor.remove')}</Text>
                </HappierPressable>
            )}
        </View>
    );
}

export function WorkflowStepDataEditor(props: Readonly<{
    draft: WorkflowEditorDraft;
    step: WorkflowStep;
    editable?: boolean;
    onChangeInput: (input: readonly WorkflowValueReference[]) => void;
    /** Opens Step options, where named results are added; absent when read-only. */
    onAddNamedResults?: () => void;
    /** A reader's fact that ends the footer line (05's "Open conversation"). */
    footerAccessory?: React.ReactNode;
    testIDPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const id = `${props.testIDPrefix}-step-${props.step.id}`;
    const editable = props.editable !== false;
    const textResult = props.step.result === undefined || props.step.result.kind === 'text';
    return (
        <View>
            {!editable ? null : props.step.input.map((reference, index) => (
                <WorkflowValueReferenceEditor
                    key={index}
                    reference={reference}
                    index={index}
                    draft={props.draft}
                    stepId={props.step.id}
                    onChange={(value) => props.onChangeInput(props.step.input.map((current, candidate) => (
                        candidate === index ? value : current
                    )))}
                    onRemove={() => props.onChangeInput(props.step.input.filter((_current, candidate) => candidate !== index))}
                    // Rows are addressed by their step, exactly as the loop editors
                    // address theirs; the bare editor prefix gave every step's first
                    // input the same identity.
                    testIDPrefix={id}
                />
            ))}
            {/* One footer line (07 S7): what the step returns, then its quiet actions. A reading
                document has no binding controls, so the step's inputs sit on that line as tokens. */}
            <View style={workflowEditorStyles.metaRow}>
                {editable ? null : props.step.input.map((reference, index) => (
                    <WorkflowValueReferenceToken key={index} draft={props.draft} reference={reference} testID={`${id}-input-${index}`} />
                ))}
                <Text testID={`${id}-returns`} style={workflowEditorStyles.groupSummary}>
                    {formatWorkflowResultSummary(props.step.result)}
                </Text>
                {editable && textResult && props.onAddNamedResults !== undefined ? (
                    <HappierPressable
                        testID={`${id}-add-named-results`}
                        accessibilityRole="button"
                        accessibilityLabel={t('workflows.page.blocks.addNamedResults')}
                        onPress={props.onAddNamedResults}
                        style={(state) => [workflowEditorStyles.actionTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        <Text style={workflowEditorStyles.footAction}>{t('workflows.page.blocks.addNamedResults')}</Text>
                    </HappierPressable>
                ) : null}
                {editable ? (
                    <HappierPressable
                        testID={`${id}-add-input`}
                        accessibilityRole="button"
                        accessibilityLabel={t('workflows.inputs.addInput')}
                        onPress={() => props.onChangeInput([...props.step.input, { kind: 'literal', value: '' }])}
                        style={(state) => [workflowEditorStyles.actionTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        <Text style={workflowEditorStyles.footAction}>{t('workflows.inputs.addInput')}</Text>
                    </HappierPressable>
                ) : null}
                {props.footerAccessory ?? null}
            </View>
        </View>
    );
}
