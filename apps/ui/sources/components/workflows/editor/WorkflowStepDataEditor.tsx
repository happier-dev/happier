import { formatWorkflowResultFieldType, formatWorkflowValueReference, workflowResultFieldText } from '../presentation/workflowValuePresentation';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowAuthoredResultReference, WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import type { WorkflowActionFieldBindingV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';
import type { WorkflowResultContract, WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';
import { projectWorkflowResultFields } from '@happier-dev/protocol/workflows/workflowResultFieldsV1';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text, TextInput } from '@/components/ui/text/Text';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { focusFirstEntryWithin } from '@/keyboard/webOverlayFocusContainment';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { t } from '@/text';

import { listWorkflowDeclaredResultFields } from '@/components/workflows/flow/workflowFlowProjection';
import { workflowEditorStyles } from './workflowEditorStyles';
import { WorkflowReferenceRawPathInput, WorkflowValuePicker } from './WorkflowValuePicker';

function literalText(value: JsonValue): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseLiteral(value: string): JsonValue {
    try { return JSON.parse(value) as JsonValue; } catch { return value; }
}

const WHOLE_RESULT = 'whole';
const OTHER_PATH = 'other';
const RESULT_FIELD_PREFIX = 'field:';

/**
 * A result's field path. When the producer declares named fields (04 §6.1) the
 * field is chosen from them ("Whole result", each field, "Another path…");
 * otherwise, or for another path, the raw path keeps its edit ("summary.")
 * while the draft echoes parsed segments.
 */
export function WorkflowResultFieldPathInput(props: Readonly<{
    reference: WorkflowAuthoredResultReference;
    onChange: (reference: WorkflowAuthoredResultReference) => void;
    testID: string;
    style?: React.ComponentProps<typeof TextInput>['style'];
    draft?: WorkflowEditorDraft;
}>): React.ReactElement {
    const producer = props.draft === undefined ? null : findWorkflowBlock(props.draft, props.reference.producer.blockId);
    const projection = producer !== null && (producer.kind === 'step' || producer.kind === 'wait')
        ? projectWorkflowResultFields(producer.result) : null;
    const fields = projection?.kind === 'fields' ? projection.fields : [];
    const [otherPath, setOtherPath] = React.useState(false);
    const path = props.reference.path;
    const namedField = path.length === 1 && typeof path[0] === 'string' && fields.some((field) => field.name === path[0]) ? path[0] : null;
    const selectedId = otherPath ? OTHER_PATH : path.length === 0 ? WHOLE_RESULT : namedField === null ? OTHER_PATH : `${RESULT_FIELD_PREFIX}${namedField}`;
    const raw = <WorkflowReferenceRawPathInput {...props} />;
    if (fields.length === 0) return raw;
    return <>
        <WorkflowFieldSelect
            testID={`${props.testID}-field`}
            label={workflowResultFieldText('field')}
            items={[
                { id: WHOLE_RESULT, testID: `${props.testID}-field-whole`, title: workflowResultFieldText('wholeResult') },
                ...fields.map((field) => ({ id: `${RESULT_FIELD_PREFIX}${field.name}`, testID: `${props.testID}-field-name-${field.name}`, title: field.name, subtitle: formatWorkflowResultFieldType(field) })),
                { id: OTHER_PATH, testID: `${props.testID}-field-other`, title: workflowResultFieldText('otherPath') },
            ]}
            selectedId={selectedId}
            onSelect={(id) => {
                setOtherPath(id === OTHER_PATH);
                if (id === OTHER_PATH) return;
                props.onChange({ ...props.reference, path: id === WHOLE_RESULT ? [] : [id.slice(RESULT_FIELD_PREFIX.length)] });
            }}
        />
        {selectedId === OTHER_PATH ? raw : null}
    </>;
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
    // A reference reads as the lab's tinted chip (`.uwe-ref`): the accent's own tint behind accent words,
    // inline in a sentence or on a step's footer line, never a bare link-coloured run of text.
    return <Text testID={props.testID} style={{ color: theme.colors.state.active.foreground, backgroundColor: theme.colors.state.active.background,
        borderRadius: theme.borderRadius.sm, paddingHorizontal: theme.space.s4 }} selectable>{`↵ ${formatWorkflowValueReference(props.draft, props.reference)}`}</Text>;
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
            </View>
            <View ref={valueRef} style={workflowEditorStyles.actionFieldValue}>
                {value}
                {/* How a field binds is help for the one changing it: it shows under the value while the
                    step is selected, never as a paragraph in the label column of a resting card. */}
                {props.note === undefined || !editing ? null
                    : <Text testID={`${props.testID}-note`} style={workflowEditorStyles.kindCardNote}>{props.note}</Text>}
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

/** The Result row's one line: "Named fields · fixed Yes/No, notes Text". */
export function formatWorkflowNamedResultSummary(
  result: WorkflowResultContract | undefined,
): string | null {
  const projection = projectWorkflowResultFields(result);
  if (projection.kind !== 'fields' || projection.fields.length === 0)
    return null;
  return workflowResultFieldText('summary', {
    fields: projection.fields
      .map((field) => `${field.name} ${formatWorkflowResultFieldType(field)}`)
      .join(', '),
  });
}


/** What a result contract returns, in the footer and in Step options' Result row. */
export function formatWorkflowResultSummary(result: WorkflowResultContract | undefined): string {
    if (result === undefined || result.kind === 'text') return t('workflows.page.blocks.returnsText');
    if (result.kind === 'json') return formatWorkflowNamedResultSummary(result) ?? t('workflows.page.inspector.returnsStructured');
    return t('workflows.page.inspector.returnsDecision');
}

/**
 * The editor's field select (a binding's source, input, step or field; an input's type): the
 * canonical `DropdownMenu` drawn as a field box, so a choice set never becomes a row of text tabs
 * that runs past the pane (07 §3 control table).
 */
export function WorkflowFieldSelect(props: Readonly<{
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
    const reference = props.reference;
    return (
        <View style={workflowEditorStyles.inlineControl}>
            {props.literalOnly === true && reference.kind === 'literal' ? null : <WorkflowValuePicker
                draft={props.draft}
                consumerBlockId={props.stepId}
                {...(props.continuation === true ? { continuation: true } : {})}
                {...(props.literalOnly === true ? { fixedOnly: true } : {})}
                reference={reference}
                label={t('workflows.input.valueKindGroup')}
                // Moving between inputs keeps the path into them; every other choice names its own.
                onChange={(next) => props.onChange(next.kind === 'input' && reference.kind === 'input' && next.path === undefined && reference.path !== undefined
                    ? { ...next, path: reference.path } : next)}
                onChooseFixedValue={() => props.onChange({ kind: 'literal', value: '' })}
                testID={`${rowId}-value`}
                pathTestID={`${rowId}-path`}
            />}
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
    /**
     * Whether the input bindings' editors show: while the step is selected, as a typed card's
     * values do (`WorkflowBindingRow`). At rest an editable step reads its inputs as the document
     * reads them, tokens on the footer line, and pressing them selects the step.
     */
    editing?: boolean;
    /** Selects the step so its inputs can be edited (pressing them at rest). */
    onEdit?: () => void;
    onChangeInput: (input: readonly WorkflowValueReference[]) => void;
    /** A reader's fact that ends the footer line (05's "Open conversation"). */
    footerAccessory?: React.ReactNode;
    testIDPrefix: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const id = `${props.testIDPrefix}-step-${props.step.id}`;
    const editable = props.editable !== false;
    const editing = editable && props.editing !== false;
    const textResult = props.step.result === undefined || props.step.result.kind === 'text';
    const namedFields = listWorkflowDeclaredResultFields(props.step.result);
    // The footer says facts only, the same selected or at rest (DESIGN-7 N27): named results
    // ("Returns issues, commits, summary"), a decision, or nothing for plain text (lab E1). Adding
    // named results or an input is Step options' (Result, Add input), so selecting moves nothing.
    // Field names read as words in a sentence ("missing evidence, next step"), never as wire keys.
    const returns = namedFields !== undefined ? t('workflows.page.blocks.returnsFields', { fields: namedFields.map(formatWorkflowResultFieldWord).join(', ') })
        : textResult ? null : formatWorkflowResultSummary(props.step.result);
    const inputTokens = editing ? [] : props.step.input;
    const showsLine = returns !== null || inputTokens.length > 0 || props.footerAccessory != null;
    // Nothing to say renders nothing: an empty line would still take the step's row gap.
    if (!showsLine && (!editing || props.step.input.length === 0)) return null;
    const tokens = inputTokens.map((reference, index) => (
        <WorkflowValueReferenceToken key={index} draft={props.draft} reference={reference} testID={`${id}-input-${index}`} />
    ));
    return (
        <View>
            {!editing ? null : props.step.input.map((reference, index) => (
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
                {editable && tokens.length > 0 && props.onEdit !== undefined ? (
                    <HappierPressable
                        testID={`${id}-inputs-edit`}
                        accessibilityRole="button"
                        accessibilityLabel={t('workflows.page.blocks.editInputs')}
                        onPress={props.onEdit}
                        style={(state) => [workflowEditorStyles.metaRow, workflowEditorStyles.inputTokensTarget,
                            state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        {tokens}
                    </HappierPressable>
                ) : tokens}
                {returns === null ? null : <Text testID={`${id}-returns`} style={workflowEditorStyles.groupSummary}>{returns}</Text>}
                {props.footerAccessory ?? null}
            </View>}
        </View>
    );
}
