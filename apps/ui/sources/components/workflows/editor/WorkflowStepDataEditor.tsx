import { formatWorkflowResultFieldType, formatWorkflowValueReference, workflowResultFieldText } from '../presentation/workflowValuePresentation';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, HappierPageRowFieldLayoutContext, HappierPressable, HAPPIER_PRESS_FEEDBACK_V1, useHappierTextPresentation } from '@happier-dev/plugin-ui/presentation';
import { useLocalSetting } from '@/sync/store/hooks';

import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowAuthoredResultReference, WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import type { WorkflowActionFieldBindingV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';
import type { WorkflowActionTextBindingV1 } from '@happier-dev/protocol/workflows/workflowActionTextV1';
import type { WorkflowResultContract, WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';
import { projectWorkflowResultFields } from '@happier-dev/protocol/workflows/workflowResultFieldsV1';
import { readWorkflowStepInputIndexV1 } from '@happier-dev/protocol/workflows/workflowComposerDocumentV1';
import { MENTION_KIND_V1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
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

import { workflowEditorStyles } from './workflowEditorStyles';
import { listWorkflowActionFieldTextParts } from './workflowActionTextField';
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
export function WorkflowValueReferenceToken(props: Readonly<{ draft: WorkflowEditorDraft; reference: WorkflowValueReference; label?: string; testID?: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    if (props.reference.kind === 'literal') {
        return <Text testID={props.testID} selectable>{formatWorkflowValueReference(props.draft, props.reference)}</Text>;
    }
    // A reference reads as the lab's tinted chip (`.uwe-ref`): the accent's own tint behind accent words,
    // inline in a sentence or on a step's footer line, never a bare link-coloured run of text.
    return <Text testID={props.testID} style={{ color: theme.colors.state.active.foreground, backgroundColor: theme.colors.state.active.background,
        borderRadius: theme.borderRadius.sm, paddingHorizontal: theme.space.s4 }} selectable>
        {/* A chip wraps whole, never inside its words (owner 2026-11-06): its spaces do not break. */}
        {`↵ ${props.label ?? formatWorkflowValueReference(props.draft, props.reference)}`.replace(/ /g, '\u00A0')}</Text>;
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

/** An Action field's text with workflow values inside: its words, each value as the same token chip a sentence uses. */
export function WorkflowActionFieldTextValue(props: Readonly<{ draft: WorkflowEditorDraft; binding: WorkflowActionTextBindingV1; testID?: string }>): React.ReactElement {
    const parts = React.useMemo(() => listWorkflowActionFieldTextParts(props.binding), [props.binding]);
    return (
        <Text testID={props.testID} style={workflowEditorStyles.actionFieldText} selectable>
            {parts.map((part, index) => part.kind === 'text' ? part.text
                : part.reference.kind === 'origin_session_id'
                    ? <Text key={index} selectable>{formatWorkflowValueReference(props.draft, part.reference)}</Text>
                    : <WorkflowValueReferenceToken key={index} draft={props.draft} reference={part.reference} label={part.label} />)}
        </Text>
    );
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
    /** The row producer's words for references, independent of unrelated prompt edits. */
    referenceLabels?: readonly string[];
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
                {binding.kind === 'text' ? <WorkflowActionFieldTextValue draft={props.draft} binding={binding} /> : (binding.kind === 'object' ? Object.entries(binding.fields)
                    : (binding.kind === 'list' ? binding.items : [binding]).map(reference => [null, reference] as const)).map(([field, reference], index) => (
                    <React.Fragment key={field ?? index}>
                        {field === null ? null : <Text style={workflowEditorStyles.actionFieldLabel}>{field}</Text>}
                        {reference.kind === 'origin_session_id'
                            ? <Text style={workflowEditorStyles.actionFieldText} selectable>{formatWorkflowValueReference(props.draft, reference)}</Text>
                            : reference.kind === 'literal'
                                ? isBlankWorkflowLiteral(reference.value)
                                    // A blank value is no value: it reads as unset, never as an empty row (DESIGN-7 N24).
                                    ? <Text style={workflowEditorStyles.metaText}>{t('workflows.page.blocks.notSet')}</Text>
                                    : <Text style={workflowEditorStyles.actionFieldText} selectable>
                                        {props.formatLiteral?.(reference.value) ?? formatWorkflowBindingLiteral(props.draft, reference, props.fieldName)}
                                    </Text>
                                : <WorkflowValueReferenceToken draft={props.draft} reference={reference} label={props.referenceLabels?.[index]} />}
                    </React.Fragment>
                ))}
            </View>
        );
    }
    const pair = (
        <WorkflowFieldPair
            label={props.label}
            trackKey={props.testID}
            valueRef={valueRef}
            marker={props.required === true && (binding === undefined || (binding.kind === 'literal' && isBlankWorkflowLiteral(binding.value))) ? (
                <Text testID={`${props.testID}-required`} style={workflowEditorStyles.actionFieldMarker}>{t('workflows.page.blocks.required')}</Text>
            ) : null}
        >
            {value}
            {/* How a field binds is help for the one changing it: it shows under the value while the
                step is selected, never as a paragraph in the label column of a resting card. */}
            {props.note === undefined || !editing ? null
                : <Text testID={`${props.testID}-note`} style={workflowEditorStyles.kindCardNote}>{props.note}</Text>}
            {props.issue === undefined || props.issue === null ? null
                : <Text testID={`${props.testID}-issue`} style={workflowEditorStyles.issueText}>{props.issue}</Text>}
        </WorkflowFieldPair>
    );
    return (
        <View testID={props.testID}>
            {rowAction === null ? <View style={workflowEditorStyles.actionFieldRow}>{pair}</View> : (
                <HappierPressable testID={rowAction.testID} accessibilityRole="button"
                    accessibilityLabel={rowAction.accessibilityLabel} onPress={rowAction.onPress}
                    style={(state) => [workflowEditorStyles.actionFieldRow,
                        state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}>
                    {pair}
                </HappierPressable>
            )}
        </View>
    );
}

const VALUE_TRACK_FIELD_LAYOUT = Object.freeze({ maxWidthPx: null, stacked: true });
/** The lab's label column (S6 `.uwe-kr`) at the default text size. */
const ACTION_FIELD_LABEL_COLUMN_PX = 120;

/**
 * A typed row's label column and value track (lab `.uwe-kr`): the label says what the value is, on the
 * card's one label track, and the value starts where every other value on the card starts.
 */
export function WorkflowFieldPair(props: Readonly<{
    /** Empty on a field's further values: they keep the label column, so they line up under the first. */
    label: string;
    /** Identifies the row on the card's label track. */
    trackKey: string;
    marker?: React.ReactNode;
    valueRef?: React.Ref<View>;
    children: React.ReactNode;
}>): React.ReactElement {
    const track = React.useContext(WorkflowKindCardLabelTrack);
    // The column is measured in text: at a larger text size it widens with its labels, so "Command" never runs into its value.
    const { metricScale } = useHappierTextPresentation({ textScale: useLocalSetting('uiFontScale') });
    return (
        <>
            <View
                style={[workflowEditorStyles.actionFieldLabelColumn, { flexBasis: ACTION_FIELD_LABEL_COLUMN_PX * metricScale },
                    track?.width == null ? null : { width: track.width }]}
                onLayout={track === null || track.width !== null ? undefined
                    : (event) => track.report(props.trackKey, event.nativeEvent.layout.width)}
            >
                <Text style={workflowEditorStyles.actionFieldLabel}>{props.label}</Text>
                {props.marker ?? null}
            </View>
            <View ref={props.valueRef} style={workflowEditorStyles.actionFieldValue}>
                {/* The value track owns its width: a field box in it spans the track, the room this row gives it,
                    rather than holding a page field's inline minimum past a narrow card's edge. */}
                <HappierPageRowFieldLayoutContext.Provider value={VALUE_TRACK_FIELD_LAYOUT}>{props.children}</HappierPageRowFieldLayoutContext.Provider>
            </View>
        </>
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


/** What a result contract returns, in Step options' Result row. */
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
    const rowId = `${props.testIDPrefix}-input-${props.index}`;
    const reference = props.reference;
    return (
        <View style={[workflowEditorStyles.inlineControl, workflowEditorStyles.bindingLine]}>
            {/* A typed value is the field itself, first, so one press on "+ Set" lands in it and typing
                starts (owner G1, 11-15); choosing a value from elsewhere is the picker after it. */}
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
            {/* Removing a value is the editor's quiet trailing x on its line (as a condition's value), so it
                keeps the picker's line on a phone instead of a lone word beneath it. */}
            {props.onRemove === undefined ? null : (
                <IconButton testID={`${rowId}-remove`} variant="plain" iconName="x"
                    accessibilityLabel={t('workflows.editor.remove')} tooltip={t('workflows.editor.remove')}
                    onPress={props.onRemove} />
            )}
        </View>
    );
}

/**
 * The values a step's prompt gets without naming them (owner 2026-11-15: no "Uses …" or
 * "Returns …" lines). A value the prompt mentions reads in the prompt as its token; the runtime
 * appends every other bound value after the prompt text, so those trail the prompt as tokens, in
 * the card body. Selected, each trailing value is its binding editor; at rest pressing one selects
 * the step. What a step returns is Step options' Result row.
 */
export function WorkflowStepDataEditor(props: Readonly<{
    draft: WorkflowEditorDraft;
    step: WorkflowStep;
    editable?: boolean;
    /** Whether the trailing values' binding editors show: while the step is selected. */
    editing?: boolean;
    /** Selects the step so its values can be edited (pressing them at rest). */
    onEdit?: () => void;
    onChangeInput: (input: readonly WorkflowValueReference[]) => void;
    onRemoveInput?: (index: number) => void;
    /** A reader's fact on the step's footer line (05's "Open conversation", a Test Run's output). */
    footerAccessory?: React.ReactNode;
    testIDPrefix: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const id = `${props.testIDPrefix}-step-${props.step.id}`;
    const editable = props.editable !== false;
    const editing = editable && props.editing !== false;
    const trailing = listWorkflowStepTrailingInputIndexes(props.step);
    if (trailing.length === 0 && props.footerAccessory == null) return null;
    const tokens = editing ? [] : trailing.map((index) => (
        <WorkflowValueReferenceToken key={index} draft={props.draft} reference={props.step.input[index]!} testID={`${id}-input-${index}`} />
    ));
    return (
        <View>
            {!editing ? null : trailing.map((index) => (
                <View key={index} testID={`${id}-input-${index}-row`} style={workflowEditorStyles.actionFieldRow}>
                    <WorkflowValueReferenceEditor
                        reference={props.step.input[index]!}
                        index={index}
                        draft={props.draft}
                        stepId={props.step.id}
                        onChange={(value) => props.onChangeInput(props.step.input.map((current, candidate) => (
                            candidate === index ? value : current
                        )))}
                        onRemove={props.onRemoveInput ? () => props.onRemoveInput?.(index) : undefined}
                        // Rows are addressed by their step, exactly as the loop editors
                        // address theirs; the bare editor prefix gave every step's first
                        // input the same identity.
                        testIDPrefix={id}
                    />
                </View>
            ))}
            {tokens.length === 0 && props.footerAccessory == null ? null : <View testID={`${id}-footer`} style={workflowEditorStyles.metaRow}>
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
                {props.footerAccessory ?? null}
            </View>}
        </View>
    );
}

/** The step's bound values its prompt does not mention by token, in their bound order. */
export function listWorkflowStepTrailingInputIndexes(step: WorkflowStep): readonly number[] {
    const mentioned = new Set<number>();
    for (const reference of step.document.references) {
        if (reference.kind !== MENTION_KIND_V1.workflowInput) continue;
        const index = readWorkflowStepInputIndexV1(reference.ref);
        if (index !== null) mentioned.add(index);
    }
    return step.input.flatMap((_, index) => (mentioned.has(index) ? [] : [index]));
}
