import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import type { JsonValue } from '@happier-dev/protocol';
import { parsePermissionIntentAlias } from '@happier-dev/agents/permissions';
import { WorkflowLoopOutcomeV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowAuthoredResultReference, WorkflowReferenceScope, WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import type { WorkflowActionFieldBindingV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';
import type { WorkflowResultContract, WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text, TextInput } from '@/components/ui/text/Text';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { focusFirstEntryWithin } from '@/keyboard/webOverlayFocusContainment';
import {
    listWorkflowProducerOptions,
    resolveWorkflowReferenceScopeFacts,
} from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { t } from '@/text';
import { en } from '@/text/translations/en';

import { listWorkflowDeclaredResultFields } from '@/components/workflows/flow/workflowFlowProjection';
import { workflowEditorStyles } from './workflowEditorStyles';

type ItemReferenceField = Extract<WorkflowValueReference, { kind: 'item' }>['field'];
type IterationReferenceField = Extract<WorkflowValueReference, { kind: 'iteration' }>['field'];

/** The canonical field vocabulary of each loop-scoped reference kind, in the schema's order. */
const ITEM_REFERENCE_FIELDS: readonly ItemReferenceField[] = ['value', 'index', 'position', 'count'];
const ITERATION_REFERENCE_FIELDS: readonly IterationReferenceField[] = ['index', 'position', 'count', 'stopReason'];

/** The same human field name reads an Action row, a child input and a reference. */
export function formatWorkflowFieldLabel(name: string, title?: string): string {
    if (Object.hasOwn(en.workflows.page.fields, name)) {
        return t(`workflows.page.fields.${name as keyof typeof en.workflows.page.fields}`);
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
            // A field reads as its step and field ("Check the fix · Fixed", lab E1); the whole result keeps its noun.
            return reference.path.length === 0
                ? t('workflows.input.previousResult', { block: producerLabel(reference.producer) })
                : withPath(producerLabel(reference.producer), reference.path);
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

/**
 * The document's reference token, including in a loop/condition sentence. A literal is the value
 * itself, so it reads as words in the sentence ("Repeat 2 times"), never as a binding token.
 */
export function WorkflowValueReferenceToken(props: Readonly<{ draft: WorkflowEditorDraft; reference: WorkflowValueReference; testID?: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    if (props.reference.kind === 'literal') {
        return <Text testID={props.testID} selectable>{formatWorkflowValueReference(props.draft, props.reference)}</Text>;
    }
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

/**
 * One label/value row of a typed step's card (lab `.uwe-kr`): an Action field or a child workflow's
 * input. The label column says what it is (and "Required" while it is unset); the value reads as the
 * document reads it — a literal as its words, anything else as the reference token — and, editing,
 * as the caller's binding editor. An unset field shows its declared default quietly (pressing it
 * binds that value to edit) or "+ Set"; a reader sees "Not set" only on a required field, and an
 * optional unset field without a default is left out of a reading document (lab S6 reads two rows).
 */
export function WorkflowBindingRow(props: Readonly<{
    label: string;
    required?: boolean;
    /** A fact about how this field binds ("Values go in as environment variables"). */
    note?: string;
    binding: WorkflowActionFieldBindingV1 | undefined;
    /** The value an unset field resolves to, already in the reader's words. */
    defaultLabel?: string;
    draft: WorkflowEditorDraft;
    /** The field name a declared literal is read against (an Action's `target`, `permissionMode`). */
    fieldName?: string;
    editable: boolean;
    /**
     * Whether the bound value's editor shows: while its step is selected. At rest an editable card
     * reads its values as values ("Channel  #releases", lab S6) and pressing one selects the step.
     */
    editing?: boolean;
    /** Selects the step so its values can be edited (pressing a value at rest). */
    onEdit?: () => void;
    /** Binds an unset field (editing only). */
    onSet?: () => void;
    /** Draws the bound value's editor (editing only). */
    renderEditor?: () => React.ReactNode;
    /** This field's revealed issue, in the editor's words; marks the row (DESIGN-6 P3). */
    issue?: string | null;
    /** A bound literal in the field's own option words ("Acme reviewer"), when it has options. */
    formatLiteral?: (value: JsonValue) => string | null;
    testID: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const { binding } = props;
    const track = React.useContext(WorkflowKindCardLabelTrack);
    const editing = props.editable && props.editing !== false;
    // "+ Set" unmounts the control that had focus; its value editor takes it, so focus never drops
    // to the page body (DESIGN-9 N5). Web only: native focus has no body to fall to.
    const valueRef = React.useRef<View>(null);
    const focusValueOnOpen = React.useRef(false);
    const valueEditorOpen = binding !== undefined && editing && props.renderEditor !== undefined;
    React.useEffect(() => {
        if (!focusValueOnOpen.current || !valueEditorOpen) return;
        focusValueOnOpen.current = false;
        const node = valueRef.current as unknown;
        if (Platform.OS === 'web' && typeof HTMLElement !== 'undefined' && node instanceof HTMLElement) focusFirstEntryWithin(node);
    }, [valueEditorOpen]);
    // A reader sees what the step will use: a field nobody set, with no default, says nothing — a
    // read-only built-in never reads "Required · Not set" (DESIGN-5 M4). Editing still offers "+ Set".
    if (!props.editable && binding === undefined && props.defaultLabel === undefined) return null;
    // The whole pair is the one press target while it has one action ("+ Set", a default to take,
    // a value to edit), so a value needs no touch frame of its own and stays right under its label
    // on a phone (DESIGN-7 N5). Editing, the binding's own controls take the presses.
    let rowAction: Readonly<{ testID: string; accessibilityLabel: string; onPress: () => void }> | null = null;
    let value: React.ReactNode;
    if (binding === undefined) {
        const settable = props.editable && props.onSet !== undefined;
        if (settable) rowAction = { testID: `${props.testID}-set`, accessibilityLabel: `${t('workflows.page.blocks.set')} ${props.label}`, onPress: () => {
            focusValueOnOpen.current = true;
            props.onSet!();
        } };
        value = props.defaultLabel !== undefined ? <Text style={workflowEditorStyles.metaText}>{props.defaultLabel}</Text>
            : settable ? (
                <View style={workflowEditorStyles.addRow}>
                    <Icon name="plus" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                    <Text style={workflowEditorStyles.footAction}>{t('workflows.page.blocks.set')}</Text>
                </View>
            ) : <Text style={workflowEditorStyles.metaText}>{t('workflows.page.blocks.notSet')}</Text>;
    } else if (editing && props.renderEditor !== undefined) {
        value = props.renderEditor();
    } else {
        if (props.editable && props.onEdit !== undefined) {
            rowAction = { testID: `${props.testID}-edit`, accessibilityLabel: `${t('common.edit')} ${props.label}`, onPress: props.onEdit };
        }
        value = (
            <View testID={`${props.testID}-value`} style={workflowEditorStyles.metaRow}>
                {(binding.kind === 'list' ? binding.items : [binding]).map((reference, index) =>
                    reference.kind === 'origin_session_id'
                        ? <Text key={index} style={workflowEditorStyles.actionFieldText} selectable>{t('workflows.page.inspector.originSession')}</Text>
                        : reference.kind === 'literal'
                            ? isBlankWorkflowLiteral(reference.value)
                                // A blank value is no value: it reads as unset, never as an empty row (DESIGN-7 N24).
                                ? <Text key={index} style={workflowEditorStyles.metaText}>{t('workflows.page.blocks.notSet')}</Text>
                                : <Text key={index} style={workflowEditorStyles.actionFieldText} selectable>
                                    {props.formatLiteral?.(reference.value) ?? formatWorkflowBindingLiteral(props.draft, reference, props.fieldName)}
                                </Text>
                            : <WorkflowValueReferenceToken key={index} draft={props.draft} reference={reference} />)}
            </View>
        );
    }
    const pair = (
        <>
            <View
                style={[workflowEditorStyles.actionFieldLabelColumn, track?.width == null ? null : { width: track.width }]}
                onLayout={track === null || track.width !== null ? undefined
                    : (event) => track.report(props.testID, event.nativeEvent.layout.width)}
            >
                <Text style={workflowEditorStyles.actionFieldLabel}>{props.label}</Text>
                {props.required === true && (binding === undefined || (binding.kind === 'literal' && isBlankWorkflowLiteral(binding.value))) ? (
                    <Text testID={`${props.testID}-required`} style={workflowEditorStyles.actionFieldMarker}>{t('workflows.page.blocks.required')}</Text>
                ) : null}
                {props.note === undefined ? null : <Text style={workflowEditorStyles.groupSummary}>{props.note}</Text>}
            </View>
            <View ref={valueRef} style={workflowEditorStyles.actionFieldValue}>
                {value}
                {props.issue === undefined || props.issue === null ? null
                    : <Text testID={`${props.testID}-issue`} style={workflowEditorStyles.issueText}>{props.issue}</Text>}
            </View>
        </>
    );
    return (
        <View testID={props.testID}>
            {rowAction === null ? <View style={workflowEditorStyles.actionFieldRow}>{pair}</View> : (
                <HappierPressable testID={rowAction.testID} accessibilityRole="button"
                    accessibilityLabel={rowAction.accessibilityLabel} onPress={rowAction.onPress}
                    style={(state) => [workflowEditorStyles.actionFieldRow, workflowEditorStyles.actionFieldRowTarget,
                        state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}>
                    {pair}
                </HappierPressable>
            )}
        </View>
    );
}

/** A literal with nothing in it (`""`, spaces): what a pressed "+ Set" leaves before a value is typed. */
function isBlankWorkflowLiteral(value: JsonValue): boolean {
    return typeof value === 'string' && value.trim().length === 0;
}

/**
 * A literal in a label/value row — bound, or a child input's default — reads as the value itself:
 * "complete", "#releases", "open" — no quotes (the row already says it is a value, lab S6), an
 * identifier's underscores as spaces.
 * Declared execution fields (`target`, `permissionMode`) keep their own words.
 */
export function formatWorkflowBindingLiteral(draft: WorkflowEditorDraft, reference: Extract<WorkflowValueReference, { kind: 'literal' }>, fieldName?: string): string {
    if (typeof reference.value === 'string' && fieldName !== 'permissionMode') {
        return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(reference.value) ? reference.value.replaceAll('_', ' ') : reference.value;
    }
    return formatWorkflowValueReference(draft, reference, fieldName);
}

/**
 * One label track per typed card (lab `.uwe-kr`: every value starts on one column). Each row
 * reports its label's natural width once; the card's track is the widest, so values line up
 * instead of starting where each label ends (DESIGN-6 N5).
 */
export const WorkflowKindCardLabelTrack = React.createContext<Readonly<{
    width: number | null;
    report: (rowKey: string, width: number) => void;
}> | null>(null);

/** A declared result field inside the "Returns …" sentence: its words, lower-case ("missingEvidence" → "missing evidence"). */
function formatWorkflowResultFieldWord(name: string): string {
    const words = name.replace(/([a-z\d])([A-Z])/gu, '$1 $2').replace(/[_\-.]+/gu, ' ').trim();
    // Only a key is lower-cased; an authored title keeps its own capitals.
    return /^[a-z][A-Za-z\d_\-.]*$/u.test(name) ? words.toLocaleLowerCase() : words;
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
                        // The field box inside draws the ring.
                        style={HAPPIER_FOCUS_RING_DELEGATED_STYLE}
                    >
                        {(state) => renderDropdownItemTriggerRightElement({
                            detail: typeof selected?.title === 'string' ? selected.title : null,
                            open,
                            detailColor: theme.colors.text.primary,
                            chevronColor: theme.colors.text.secondary,
                            detailDensity: 'compact',
                            field: resolveFieldBoxColors(theme, state.focused ? 'focused' : 'idle'),
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
    /** The consuming field's canonical contract accepts authored literals only. */
    literalOnly?: boolean;
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
    const kinds = props.literalOnly === true ? ['literal'] as const : [
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
            {props.literalOnly !== true || reference.kind !== 'literal' ? <ReferenceSelect
                testID={`${rowId}-kind`}
                label={t('workflows.input.valueKindGroup')}
                items={kinds.map((kind) => ({ id: kind, testID: `${rowId}-kind-${kind}`, title: referenceKindLabel(kind) }))}
                selectedId={reference.kind}
                onSelect={(id) => {
                    const kind = kinds.find((candidate) => candidate === id);
                    if (kind !== undefined) setKind(kind);
                }}
            /> : null}
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
                    // An empty value well says what goes in it (DESIGN-7 N5), never a blank grey box.
                    placeholder={t('workflows.condition.literalPlaceholder')}
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
    /** A reader's fact that ends the footer line (05's "Open conversation"). */
    footerAccessory?: React.ReactNode;
    testIDPrefix: string;
}>): React.ReactElement | null {
    const id = `${props.testIDPrefix}-step-${props.step.id}`;
    const editable = props.editable !== false;
    const textResult = props.step.result === undefined || props.step.result.kind === 'text';
    const namedFields = listWorkflowDeclaredResultFields(props.step.result);
    // The footer says facts only, the same selected or at rest (DESIGN-7 N27): named results
    // ("Returns issues, commits, summary"), a decision, or nothing for plain text (lab E1). Adding
    // named results or an input is Step options' (Result, Add input), so selecting moves nothing.
    // Field names read as words in a sentence ("missing evidence, next step"), never as wire keys.
    const returns = namedFields !== undefined ? t('workflows.page.blocks.returnsFields', { fields: namedFields.map(formatWorkflowResultFieldWord).join(', ') })
        : textResult ? null : formatWorkflowResultSummary(props.step.result);
    const inputTokens = editable ? [] : props.step.input;
    const showsLine = returns !== null || inputTokens.length > 0 || props.footerAccessory != null;
    // Nothing to say renders nothing: an empty line would still take the step's row gap.
    if (!showsLine && (!editable || props.step.input.length === 0)) return null;
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
            {/* One footer line (07 S7): what the step returns. A reading document has no binding
                controls, so the step's inputs sit on that line as tokens. */}
            {!showsLine ? null : <View testID={`${id}-footer`} style={workflowEditorStyles.metaRow}>
                {inputTokens.map((reference, index) => (
                    <WorkflowValueReferenceToken key={index} draft={props.draft} reference={reference} testID={`${id}-input-${index}`} />
                ))}
                {returns === null ? null : <Text testID={`${id}-returns`} style={workflowEditorStyles.groupSummary}>{returns}</Text>}
                {props.footerAccessory ?? null}
            </View>}
        </View>
    );
}
