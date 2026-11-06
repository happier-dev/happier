import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { classifyWorkflowHoldV1, WorkflowAuthoredInputV1Schema, type WorkflowAuthoredInputV1, type WorkflowInvocationLifecycleV1, type WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { sameStrictJsonValue, StrictJsonValueSchema, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { workflowInputTitle, type WorkflowResultContract } from '@happier-dev/protocol/workflows/workflowV1';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { decodeExecutionRunResultObservation } from '@happier-dev/protocol/execution/runs/resultContract';
import { resolveHappierChoiceControl, resolveHappierStateAnnouncement } from '@happier-dev/plugin-ui/presentation';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { usePaneHeaderScrollSink } from '@/components/appShell/panes/paneHeaderScroll';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { AgentInputDocumentPreviewText } from '@/components/sessions/agentInput/components/AgentInputDocumentPreviewText';
import { projectAuthoringDocumentPreview } from '@/components/sessions/authoring/authoringDocumentPreview';
import { projectWorkflowRunInputFields } from '@/sync/domains/workflows/workflowAuthoring';
import { formatWorkflowInputValue, parseWorkflowInputTextDraft } from '@/sync/domains/workflows/workflowInputText';
import { readWorkflowPlanResult } from '@/sync/domains/workflows/workflowPlanReview';
import { t } from '@/text';
import type { WorkflowProblemPresentation } from '../presentation/workflowProblemPresentation';
import { useWorkflowCardModal } from './useWorkflowCardModal';
import { readWorkflowResultRows } from '../presentation/workflowResultReading';
import { describeWorkflowInvocationLifecycle } from '../presentation/workflowLifecyclePresentation';

export type WorkflowReviewDraft = Readonly<{ text: string; contentRevision: string }>;
export type WorkflowReviewReading = Readonly<{ value: JsonValue | undefined; revision: string }>;
export type WorkflowReviewChoice = Readonly<{ expectedContentRevision: string }> & (
    | Readonly<{ mode: 'use_result'; value?: JsonValue }>
    | Readonly<{ mode: 'generate' }>
);
export type WorkflowReviewCardProps = Readonly<{
    progress: WorkflowProgressEnvelopeV1;
    contract: WorkflowResultContract | undefined;
    waitForYou: boolean;
    /** The exact frozen Wait's authored question and selected occurrence identity. */
    waitIdentity?: Readonly<{
        /** Omit identity title/subtitle when existing pane/modal chrome already owns them. */
        title?: string;
        subtitle?: string | null;
        prompt: string;
    }>;
    contentRevision: string;
    draft: WorkflowReviewDraft | undefined;
    onChangeDraft: (draft: WorkflowReviewDraft | undefined) => void;
    reading?: WorkflowReviewReading;
    onChangeReading?: (reading: WorkflowReviewReading) => void;
    onComplete: (choice: WorkflowReviewChoice) => Promise<void>;
    onDiscuss?: () => void;
    onEditPlan?: (value: JsonValue, expectedContentRevision: string) => Promise<void>;
    onRunPlan?: (value: JsonValue, expectedContentRevision: string) => Promise<void>;
    startedPlanRunId?: string | null;
    earlierPlanRunId?: string | null;
    onOpenPlanRun?: (runId: string) => void;
    planProposalValid?: boolean;
    planProposalPreview?: React.ReactNode;
    lifecycle?: WorkflowInvocationLifecycleV1;
    isCurrent?: boolean;
    pending?: boolean;
    problem?: WorkflowProblemPresentation | null;
    canGenerate?: boolean;
    readOnly?: boolean;
    /** Edit authority remains, but the exact evidence is not confirmed yet. */
    disabled?: boolean;
    parentPaused?: boolean;
    machineReachable?: boolean;
    machineName?: string | null;
    resultSourceLabel?: string;
    primaryActionPlacement?: 'inline' | 'footer';
    /** A sheet's height is its owner's: the card fills it rather than sizing to its content. */
    fillHeight?: boolean;
    /** The step's other facts, scrolled with the value above the pinned decision. */
    belowResult?: React.ReactNode;
    testIDPrefix?: string;
}>;

const styles = StyleSheet.create((theme) => ({
    root: { minWidth: 0 },
    filled: { flex: 1, minHeight: 0 },
    /** Sized to its content inside a bounded region, and the first thing to give way when the region is short. */
    fitted: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
    actions: { gap: theme.space.s8, alignItems: 'stretch' },
    /** The decision: the primary, its one consequence, then the quiet choices. */
    decision: { gap: theme.space.s8, paddingTop: theme.space.s12, alignItems: 'stretch' },
    quietActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', columnGap: theme.space.s4 },
    head: { gap: theme.space.s4 },
    /** The one place that says this needs the person: amber on the word and the hand, nothing else. */
    stateLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space.s6, paddingBottom: theme.space.s12 },
    stateWord: { color: theme.colors.state.warning.foreground },
    /** Where the value came from, with its Copy and Expand, directly above it. */
    valueHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, paddingBottom: theme.space.s4, minHeight: theme.space.s32 },
    valueSource: { flex: 1, minWidth: 0, color: theme.colors.text.secondary },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
    secondary: { color: theme.colors.text.secondary },
    /** A value read back (a step's input, a published result): primary ink in both themes. */
    value: { color: theme.colors.text.primary },
    error: { color: theme.colors.text.destructive },
    /** The primary's consequence and its one blocked reason sit centred under it (lab H1). */
    footnote: { textAlign: 'center' },
    preview: { minHeight: 0, overflow: 'hidden' },
    // A presentation viewport, not a value cutoff: about twelve body lines keeps the decision nearby.
    previewScroll: { maxHeight: 240 },
}));

/** The touch key of a value edited as one field (the whole result, or a decision). */
const VALUE_FIELD = '$value';

function objectValue(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
    return isObjectValue(value) ? value : null;
}
function isObjectValue(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function decodeWorkflowReviewDraft(text: string, contract: WorkflowResultContract | undefined): JsonValue | undefined {
    if (!contract || contract.kind === 'text') return text;
    try {
        const parsed = StrictJsonValueSchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : undefined;
    } catch { return undefined; }
}
export function serializeWorkflowReviewValue(value: JsonValue | undefined, contract: WorkflowResultContract | undefined): string {
    return value === undefined ? contract?.kind === 'json' ? '{}' : ''
        : !contract || contract.kind === 'text' ? typeof value === 'string' ? value : JSON.stringify(value, null, 2)
            : JSON.stringify(value, null, 2);
}
/** Complex schemas retain the entire JSON document; scalar fields share the input owners. */
function simpleFields(contract: WorkflowResultContract | undefined): Readonly<Record<string, PluginJsonSchemaV2>> | null {
    if (contract?.kind !== 'json' || contract.schema.type !== 'object' || !contract.schema.properties) return null;
    const schema = contract.schema;
    if (schema.$ref || schema.allOf || schema.anyOf || schema.oneOf || schema.not || schema.propertyNames) return null;
    const fields = contract.schema.properties;
    if (!Object.values(fields).every((field) => !field.$ref && !field.allOf && !field.anyOf && !field.oneOf && !field.not
        && (field.type === 'string' || field.type === 'number' || field.type === 'integer' || field.type === 'boolean'))) return null;
    return fields;
}

/** A string field is long text when its schema allows a paragraph or its current value already is one. */
function isLongTextField(schema: PluginJsonSchemaV2, value: unknown): boolean {
    return (schema.maxLength ?? 0) > 200 || (typeof value === 'string' && (value.includes('\n') || value.length > 80));
}

type ReviewValueProps = Readonly<{ value: JsonValue; contract: WorkflowResultContract | undefined; testIDPrefix: string }>;

/**
 * Provider rendering and resolved values belong to execution custody. The reading projection is the
 * authored document itself, drawn by the composer's own picture: its words with each reference as the
 * inline chip the editor shows, never a separate row.
 */
function WorkflowAuthoredInputReading({ document, testID }: Readonly<{ document: WorkflowAuthoredInputV1['document']; testID: string }>): React.ReactElement {
    const preview = projectAuthoringDocumentPreview(document);
    return <View testID={testID}><AgentInputDocumentPreviewText value={preview.text} references={preview.references} placeholder="" fieldInset={false} /></View>;
}

/**
 * Both the bounded reading and full inspection render the same exact value with the established viewers;
 * a settled or stopped attempt's detail reads its answer through the same rows (DESIGN-16 D5).
 */
export function WorkflowReviewValue({ value, contract, testIDPrefix: prefix }: ReviewValueProps): React.ReactElement {
    // A step's authored input reads as the words it was given, never as its wire envelope (DESIGN-17 R1).
    const authored = contract === undefined ? WorkflowAuthoredInputV1Schema.safeParse(value) : null;
    if (authored?.success) {
        return <SectionContentRow><WorkflowAuthoredInputReading document={authored.data.document} testID={`${prefix}-value`} /></SectionContentRow>;
    }
    const plan = contract?.kind === 'json' ? readWorkflowPlanResult(value) : null;
    if (plan) return <SectionContentRow><MarkdownView testID={`${prefix}-plan-document`} markdown={plan.document} /></SectionContentRow>;
    // A structured result reads as label/value rows (lab run-A_completed): fields by their human names, a list
    // one row per item. Raw serialization is only ever behind Copy.
    const titles = contract?.kind === 'json' ? Object.fromEntries(Object.entries(contract.schema.properties ?? {})
        .map(([name, schema]) => [name, schema.title])) : undefined;
    const rows = readWorkflowResultRows(value, titles);
    return rows ? <>{rows.map(row =>
        <Item key={row.key} title={row.label} showChevron={false} accessoryLayout="stacked"
            rightElement={<Text selectable style={styles.value} testID={`${prefix}-value-${row.key}`}>{row.text}</Text>} />)}</>
        : <SectionContentRow><Text selectable style={styles.value} testID={`${prefix}-value`}>{serializeWorkflowReviewValue(value, contract)}</Text></SectionContentRow>;
}

function WorkflowReviewFullValue(props: ReviewValueProps): React.ReactElement {
    return <View testID={`${props.testIDPrefix}-value`}><ListPresentationProvider value="page"><ItemGroup>
        <WorkflowReviewValue {...props} />
        <Item testID={`${props.testIDPrefix}-copy`} title={t('common.copy')} copy={serializeWorkflowReviewValue(props.value, props.contract)} showChevron={false} />
    </ItemGroup></ListPresentationProvider></View>;
}

/** Exact-result presentation. The caller owns drafts, Actions, authority and Plan admission. */
export function WorkflowReviewCard(props: WorkflowReviewCardProps): React.ReactElement {
    const paneHeaderScroll = usePaneHeaderScrollSink();
    const prefix = props.testIDPrefix ?? 'workflow-review';
    const { theme } = useUnistyles();
    // Reading a publication does not silently swap the value under the person's next decision.
    const [localReading, setLocalReading] = React.useState<WorkflowReviewReading>(() => ({ value: props.progress.result, revision: props.contentRevision }));
    const reading = props.reading ?? localReading;
    const setReading = props.onChangeReading ?? setLocalReading;
    const [openField, setOpenField] = React.useState<string | null>(null);
    const [fullValue, setFullValue] = React.useState<ReviewValueProps | null>(null);
    const writeClipboard = useClipboardWrite();
    const closeFullValue = React.useCallback(() => setFullValue(null), []);
    const fullPlan = fullValue?.contract?.kind === 'json' ? readWorkflowPlanResult(fullValue.value) : null;
    useWorkflowCardModal({ open: fullValue !== null, component: WorkflowReviewFullValue, props: fullValue,
        title: t(fullPlan ? 'workflows.review.planTitle' : 'workflows.review.title'),
        testID: `${prefix}-full`, onRequestClose: closeFullValue });
    const previewFades = useScrollEdgeFades({ enabledEdges: { top: true, bottom: true } });
    const supplied = props.draft !== undefined;
    /**
     * Untouched fields never speak (07 §3 "One validity readout"): a field says
     * what is wrong only after the person changed it. A draft that already
     * exists when the card mounts was written by the person, so it speaks.
     */
    const [touched, setTouched] = React.useState<ReadonlySet<string>>(() => new Set());
    const [draftAtMount] = React.useState(supplied);
    const isTouched = (name: string) => draftAtMount || touched.has(name);
    const touch = (name: string) => setTouched((current) => current.has(name) ? current : new Set([...current, name]));
    // An unchanged read can use the live token; human edits never silently rebase.
    const unchangedRead = !supplied && sameStrictJsonValue(reading.value, props.progress.result);
    const revision = props.draft?.contentRevision ?? (unchangedRead ? props.contentRevision : reading.revision);
    const shown = props.draft ? decodeWorkflowReviewDraft(props.draft.text, props.contract) : reading.value;
    const validation = shown === undefined ? null : decodeExecutionRunResultObservation({ encoding: 'typed', value: shown }, props.contract);
    const valid = validation?.ok === true;
    const noValueNeeded = props.waitForYou && props.contract === undefined;
    const blocked = props.pending === true || props.readOnly === true || props.disabled === true;
    const generatePrimary = !props.waitForYou && !valid && props.draft === undefined && props.canGenerate !== false;
    const readiness = classifyWorkflowHoldV1({ lifecycle: props.lifecycle ?? 'waiting_for_review',
        isCurrent: props.isCurrent ?? true, progress: props.progress });
    const held = readiness !== 'resolved';
    const fields = simpleFields(props.contract);
    // A hold that asks for one value speaks of one (DESIGN-17 R10); a decision or plain value is one too.
    const singleField = fields === null || Object.keys(fields).length === 1;
    const editing = supplied || (props.waitForYou && !noValueNeeded && held && !props.readOnly);
    const changed = props.contentRevision !== revision;
    const plan = !props.waitForYou && props.contract?.kind === 'json' && shown !== undefined ? readWorkflowPlanResult(shown) : null;
    const planValue = plan !== null && valid ? shown : undefined;
    const issues = validation && !validation.ok ? validation.issues ?? [] : [];
    // A held result needs no title: the state line says what this is, and the value is what it shows.
    const title = props.waitForYou ? props.waitIdentity ? props.waitIdentity.title : t('workflows.review.waitTitle') : editing ? t('workflows.review.editsTitle')
        : plan ? t('workflows.review.planTitle') : !valid ? t('workflows.review.noValue') : held ? undefined : t('workflows.review.title');
    const updateText = (text: string) => props.onChangeDraft({ text, contentRevision: revision });
    const showNewer = () => {
        if (props.pending === true) return;
        setReading({ value: props.progress.result, revision: props.contentRevision });
        props.onChangeDraft(undefined);
    };
    const use = async () => {
        if (blocked || !held || (!valid && !noValueNeeded)) return;
        await props.onComplete({ mode: 'use_result', expectedContentRevision: revision,
            ...(supplied && shown !== undefined && !noValueNeeded ? { value: shown } : {}) });
    };
    const generate = async () => {
        if (blocked || !held || props.waitForYou || props.canGenerate === false) return;
        await props.onComplete({ mode: 'generate', expectedContentRevision: revision });
    };
    const seedEdit = () => { if (!blocked) updateText(serializeWorkflowReviewValue(reading.value, props.contract)); };
    const valueObject = objectValue(shown) ?? {};
    const definitions = fields === null ? [] : Object.entries(fields).map(([name, schema]) => ({ name,
        valueType: schema.type === 'integer' ? 'number' as const : schema.type as 'string' | 'number' | 'boolean',
        required: props.contract?.kind === 'json' && props.contract.schema.required?.includes(name) === true,
        ...(schema.description ? { description: schema.description } : {}) }));
    const projected = projectWorkflowRunInputFields({ inputs: definitions, values: valueObject });
    const changeField = (name: string, value: JsonValue | undefined) => {
        if (blocked) return;
        touch(name);
        const next = { ...valueObject };
        if (value === undefined) delete next[name]; else next[name] = value;
        updateText(JSON.stringify(next, null, 2));
    };
    // The result contract supplies choices; structured decisions retain their full JSON/reason editor.
    const decisionChoices = props.contract?.kind === 'decision' && (shown === undefined || typeof shown === 'string')
        ? props.contract.decisions : null;
    const selectDecision = (value: string) => { if (!blocked) { touch(VALUE_FIELD); updateText(JSON.stringify(value)); } };
    const fieldForm = decisionChoices === null && fields !== null && (shown === undefined || objectValue(shown) !== null);
    const fieldErrorOf = (field: (typeof projected)[number]): string | null => {
        if (!isTouched(field.definition.name)) return null;
        const pointer = `/${field.definition.name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        if (field.blocking) return t(`workflows.issue.${field.errorCode ?? 'invalid_input'}`);
        return issues.some((issue) => issue.pointer === pointer) ? t('workflows.issue.invalid_input') : null;
    };
    const valueError = !fieldForm && isTouched(VALUE_FIELD) && !valid
        ? t(shown === undefined || shown === '' ? 'workflows.issue.missing_required_input' : 'workflows.issue.invalid_input') : null;
    // One message per state: the field names its own problem; the primary says only why it is blocked.
    const hasFieldError = fieldForm ? projected.some((field) => fieldErrorOf(field) !== null) : valueError !== null;
    const validationReadout = editing && !valid && !noValueNeeded
        ? hasFieldError ? t('workflows.review.invalid') : props.waitForYou ? t(singleField ? 'workflows.review.enterValue' : 'workflows.review.enterValues') : null
        : null;
    const decisionEditor = decisionChoices === null ? null : decisionChoices.length >= 2 && decisionChoices.length <= 4
        ? <SegmentedChoiceItem title={t('workflows.input.result')} subtitle={valueError ?? undefined} disabled={blocked}
            value={typeof shown === 'string' ? shown : ''} testIDPrefix={`${prefix}-decision`}
            options={decisionChoices.map((value) => ({ id: value, label: value }))} onChange={selectDecision} />
        : <DropdownMenu testID={`${prefix}-decision`} open={openField === 'decision'}
            onOpenChange={(open) => { if (!blocked) setOpenField(open ? 'decision' : null); }}
            itemTrigger={{ title: t('workflows.input.result'), subtitle: valueError ?? undefined, itemProps: { disabled: blocked } }}
            items={decisionChoices.map((value) => ({ id: value, title: value }))}
            selectedId={typeof shown === 'string' ? shown : null} onSelect={selectDecision} />;
    // The label says what happens, so the choice needs no paragraph; its accessible hint keeps the detail.
    const quietActions = !props.readOnly && held && !props.waitForYou ? <View testID={`${prefix}-quiet-actions`} style={styles.quietActions}>
        {editing || shown === undefined ? null : <RoundButton testID={`${prefix}-edit`} size="small" display="inverted"
            title={t('common.edit')} accessibilityLabel={t('workflows.review.editResult')} disabled={blocked} onPress={seedEdit} />}
        {editing ? <RoundButton testID={`${prefix}-cancel`} size="small" display="inverted"
            title={t('common.cancel')} disabled={blocked} onPress={() => { if (!blocked) props.onChangeDraft(undefined); }} /> : null}
        {props.onDiscuss ? <RoundButton testID={`${prefix}-discuss`} size="small" display="inverted"
            title={t('workflows.review.discuss')} accessibilityHint={t('workflows.review.discussBody')}
            disabled={props.pending} onPress={props.onDiscuss} /> : null}
        {props.canGenerate !== false && !generatePrimary ? <RoundButton testID={`${prefix}-generate`} size="small" display="inverted"
            title={t('workflows.review.generate')} titleNumberOfLines="complete"
            accessibilityHint={props.parentPaused ? t('workflows.review.startsResume') : t('workflows.review.generateBody')}
            disabled={blocked} onPress={generate} /> : null}
    </View> : null;
    const primaryAction = held && !props.readOnly ? <View testID={`${prefix}-primary`} style={styles.decision}>
            <RoundButton testID={`${prefix}-${generatePrimary ? 'generate' : 'use'}`} size="normal"
                // Pending is busy, not unavailable: the primary keeps its look with the spinner in it.
                disabled={props.pending !== true && (blocked || (!generatePrimary && !valid && !noValueNeeded))} loading={props.pending} titleNumberOfLines="complete"
                title={generatePrimary ? t('workflows.review.generate') : props.waitForYou ? noValueNeeded ? t('workflows.review.continue') : t(singleField ? 'workflows.review.useValue' : 'workflows.review.useValues')
                    : plan ? t('workflows.review.usePlan') : t('workflows.review.useResult')}
                onPress={generatePrimary ? generate : use} />
            {validationReadout ? <Text testID={`${prefix}-validation`} style={[hasFieldError ? styles.error : styles.secondary, styles.footnote]}
                accessibilityRole={hasFieldError ? 'alert' : undefined}>{validationReadout}</Text> : null}
            {!noValueNeeded ? <Text style={[styles.secondary, styles.footnote]}>{generatePrimary ? props.parentPaused ? t('workflows.review.startsResume')
                : t('workflows.review.generateBody') : plan ? t('workflows.review.usePlanBody') : t('workflows.review.useBody')}</Text> : null}
            {quietActions}
    </View> : null;
    // The state line says it needs the person; the sheet stays neutral so the result reads as content
    // (lab round 1105 R1). Copy and the full reading sit on the value's own line.
    const headerActions = shown === undefined || editing ? null : <View style={styles.headerActions}>
        <IconButton testID={`${prefix}-copy`} variant="plain" iconName="copy" accessibilityLabel={t('common.copy')} tooltip={t('common.copy')}
            onPress={() => { void writeClipboard(serializeWorkflowReviewValue(shown, props.contract)); }} />
        <IconButton testID={`${prefix}-show-full`} variant="plain" iconName="arrows-out"
            accessibilityLabel={t(plan ? 'workflows.review.showFullPlan' : 'workflows.review.showFullResult')}
            tooltip={t(plan ? 'workflows.review.showFullPlan' : 'workflows.review.showFullResult')}
            onPress={() => setFullValue({ value: shown, contract: props.contract, testIDPrefix: `${prefix}-full` })} />
    </View>;
    const heldReading = held && !props.waitForYou && !editing;
    const stateLine = heldReading ? <View testID={`${prefix}-state`} style={styles.stateLine}>
        <Icon name="hand" size={ICON_SIZE.sm} color={theme.colors.state.warning.foreground} />
        <Text variant="body" emphasis="semiBold" style={styles.stateWord}>{describeWorkflowInvocationLifecycle('waiting_for_review').label}</Text>
        <Text variant="body" style={styles.secondary}>{t('workflows.review.heldConsequence')}</Text>
    </View> : null;
    const valueHead = heldReading ? <View style={styles.valueHead}>
        <Text testID={`${prefix}-source`} variant="meta" numberOfLines={1} style={styles.valueSource}>{props.resultSourceLabel ?? ''}</Text>
        {headerActions}
    </View> : null;
    // Contained: the sheet shares its edges with the state line and the decision above and below it.
    const body = <ListPresentationProvider value="page" pageInsets="contained">{stateLine}{valueHead}<ItemGroup constrainToContentWidth={false} {...(title === undefined ? { header: 'none' as const } : { title })}
            {...(heldReading ? {} : { action: headerActions })} description={props.waitForYou
            ? props.waitIdentity ? props.waitIdentity.title === undefined ? undefined
                : [props.waitIdentity.subtitle, t('workflows.review.waitTitle')].filter(Boolean).join(' · ') : t('workflows.review.waitBody')
            : editing ? t('workflows.review.editsBody') : undefined}>
            {props.waitForYou && props.waitIdentity ? <SectionContentRow>
                {/* The card's head, as the lab's hold header reads: what is asked first, then what waiting means. */}
                <View style={styles.head}>
                    {props.waitIdentity.prompt ? <MarkdownView testID={`${prefix}-wait-prompt`} markdown={props.waitIdentity.prompt} /> : null}
                    <Text style={styles.secondary}>{t('workflows.review.waitBody')}</Text>
                </View>
            </SectionContentRow> : null}
            {changed ? <SectionContentRow testID={`${prefix}-newer`}>
                <Text accessibilityLiveRegion="polite">{t('workflows.review.newer')}</Text>
                <View style={styles.actions}>{supplied ? <>
                    <RoundButton testID={`${prefix}-keep-edits`} title={t('workflows.review.keepMyEdits')} size="small"
                        display="secondary" disabled={props.pending === true} onPress={() => {
                            // Keep explicitly acknowledges this publication without replacing the person's bytes.
                            if (props.pending !== true && props.draft) props.onChangeDraft({ ...props.draft, contentRevision: props.contentRevision });
                        }} />
                    <RoundButton testID={`${prefix}-use-newer`} title={t('workflows.review.useNewer')} size="small"
                        display="inverted" disabled={props.pending === true} onPress={showNewer} />
                </> : <RoundButton testID={`${prefix}-show-newer`} title={t('workflows.review.showNewer')} size="small"
                    display="secondary" disabled={props.pending === true} onPress={showNewer} />}</View>
            </SectionContentRow> : null}
            {readiness === 'generate' ? <SectionContentRow testID={`${prefix}-generation-requested`}>
                <Text accessibilityLiveRegion="polite">{t('workflows.review.generationRequested')}</Text>
                <Text style={styles.secondary}>{props.parentPaused ? t('workflows.review.startsResume')
                    : props.machineReachable === false ? t('workflows.review.waitingMachine', { machine: props.machineName ?? t('workflows.run.technical.machine') })
                        : t('workflows.review.generateBody')}</Text>
            </SectionContentRow> : null}
            {editing && !noValueNeeded ? decisionEditor ?? (fields && fieldForm ? projected.map((field) => {
                const schema = fields[field.definition.name]!;
                const label = workflowInputTitle(field.definition, schema);
                const id = `${prefix}-field-${field.definition.name}`;
                const fieldError = fieldErrorOf(field);
                if (field.definition.valueType === 'boolean') return <SegmentedChoiceItem key={field.definition.name}
                    title={label} subtitle={fieldError ?? schema.description} disabled={blocked}
                    value={typeof field.value === 'boolean' ? String(field.value) : 'unset'} testIDPrefix={id}
                    options={[{ id: 'true', label: t('common.yes') }, { id: 'false', label: t('common.no') },
                        ...(field.definition.required ? [] : [{ id: 'unset', label: t('workflows.start.optional') }])]}
                    onChange={(value) => changeField(field.definition.name, value === 'unset' ? undefined : value === 'true')} />;
                if (schema.enum && schema.enum.every((value) => typeof value === 'string')) {
                    const choices = schema.enum.filter((value): value is string => typeof value === 'string');
                    if (resolveHappierChoiceControl({ kind: 'select', value: field.value, multiple: false }, choices.map((value) => ({ label: value }))) === 'segmented') return <SegmentedChoiceItem key={field.definition.name}
                        title={label} subtitle={fieldError ?? schema.description} disabled={blocked}
                        value={typeof field.value === 'string' ? field.value : ''} testIDPrefix={id}
                        options={choices.map((value) => ({ id: value, label: value }))}
                        onChange={(value) => changeField(field.definition.name, value)} />;
                    return <DropdownMenu key={field.definition.name} testID={id}
                        open={openField === field.definition.name} onOpenChange={(open) => {
                            if (!blocked) setOpenField(open ? field.definition.name : null);
                        }}
                        itemTrigger={{ title: label, subtitle: fieldError ?? schema.description, itemProps: { disabled: blocked } }}
                        items={choices.map((value) => ({ id: value, title: value }))}
                        selectedId={typeof field.value === 'string' ? field.value : null}
                        onSelect={(value) => { if (!blocked) changeField(field.definition.name, value); }} />;
                }
                return <Item key={field.definition.name} title={label} subtitle={schema.description} showChevron={false}
                    accessoryLayout="stacked" rightElement={<FieldTextInput testID={id}
                        value={formatWorkflowInputValue(valueObject[field.definition.name])}
                        accessibilityLabel={label} error={fieldError} editable={!blocked}
                        // Sized to its content: a one-line value is one line; only long text asks for room.
                        multiline={field.definition.valueType === 'string' && isLongTextField(schema, valueObject[field.definition.name])}
                        keyboardType={field.definition.valueType === 'number' ? 'numeric' : undefined}
                        onChangeText={(text) => {
                            const parsed = parseWorkflowInputTextDraft(field.definition, text);
                            changeField(field.definition.name, parsed.invalid ? text : field.definition.valueType === 'string' ? text : parsed.value);
                        }} />} />;
            }) : <Item title={t('workflows.input.result')} showChevron={false} accessoryLayout="stacked"
                rightElement={<FieldTextInput testID={`${prefix}-editor`} value={props.draft?.text ?? serializeWorkflowReviewValue(reading.value, props.contract)}
                    onChangeText={(text) => { if (!blocked) { touch(VALUE_FIELD); updateText(text); } }} accessibilityLabel={t('workflows.input.result')}
                    error={valueError} editable={!blocked} multiline monospace={props.contract !== undefined && props.contract.kind !== 'text'} />} />)
                : shown !== undefined ? <>
                    <View testID={`${prefix}-preview`} style={styles.preview}>
                        <ScrollView testID={`${prefix}-preview-scroll`} style={props.primaryActionPlacement === 'footer' ? undefined : styles.previewScroll} nestedScrollEnabled
                            keyboardShouldPersistTaps="handled" onLayout={previewFades.onViewportLayout}
                            onContentSizeChange={previewFades.onContentSizeChange} onScroll={previewFades.onScroll} scrollEventThrottle={16}>
                            <WorkflowReviewValue value={shown} contract={props.contract} testIDPrefix={prefix} />
                        </ScrollView>
                        <ScrollEdgeFades color={held ? theme.colors.state.warning.background : theme.colors.surface.base}
                            edges={previewFades.visibility} />
                    </View>
                </> : null}
            {shown !== undefined && !editing && !heldReading && props.resultSourceLabel ? <SectionContentRow testID={`${prefix}-source`}>
                <Text style={styles.secondary}>{props.resultSourceLabel}</Text>
            </SectionContentRow> : null}
            {plan?.proposal !== undefined && props.planProposalPreview ? <SectionContentRow>
                <Text>{t('workflows.review.proposal')}</Text>{props.planProposalPreview}
            </SectionContentRow> : null}
            {props.startedPlanRunId ? <Item title={t('workflows.review.planStarted')} showChevron={false}
                rightElement={props.onOpenPlanRun ? <RoundButton testID={`${prefix}-open-plan-run`} size="small" display="secondary"
                    title={t('workflows.run.open')} onPress={() => { if (props.startedPlanRunId) props.onOpenPlanRun?.(props.startedPlanRunId); }} /> : undefined} /> : null}
            {props.earlierPlanRunId ? <Item testID={`${prefix}-earlier-plan-run`} title={t('workflows.review.earlierPlanStarted')}
                showChevron={false} accessoryLayout="adaptive" rightElement={props.onOpenPlanRun ? <RoundButton
                    testID={`${prefix}-open-plan-run`} size="small" display="secondary" titleNumberOfLines="complete"
                    title={t('workflows.review.openEarlierPlanRun')}
                    onPress={() => { if (props.earlierPlanRunId) props.onOpenPlanRun?.(props.earlierPlanRunId); }} /> : undefined} /> : null}
            {props.problem ? <SectionContentRow>
                <Text testID={`${prefix}-action-error`} style={styles.error}
                    {...resolveHappierStateAnnouncement(props.problem.accessibilitySemantics)}>{props.problem.message}</Text>
            </SectionContentRow> : null}
            {props.primaryActionPlacement !== 'footer' && primaryAction !== null ? <SectionContentRow showDivider={false}>{primaryAction}</SectionContentRow> : null}
            {!props.readOnly && planValue !== undefined && props.onRunPlan && props.planProposalValid === true && !props.startedPlanRunId ? <Item
                title={t(props.earlierPlanRunId ? 'workflows.review.runNewProposal' : 'workflows.review.runPlan')} subtitle={t('workflows.review.runPlanBody')} showChevron={false} accessoryLayout="adaptive"
                rightElement={<RoundButton testID={`${prefix}-plan-run`} title={t(props.earlierPlanRunId ? 'workflows.review.runNewProposal' : 'workflows.review.runPlan')} titleNumberOfLines="complete" size="small" display="secondary" disabled={blocked}
                    onPress={async () => { if (!blocked) await props.onRunPlan?.(planValue, revision); }} />} /> : null}
            {!props.readOnly && planValue !== undefined && props.onEditPlan ? <Item title={t('workflows.review.editPlan')}
                subtitle={props.planProposalValid ? t('workflows.review.editPlanBody') : t('workflows.review.editPlanFallback')} showChevron={false} accessoryLayout="adaptive"
                rightElement={<RoundButton testID={`${prefix}-plan-edit`} title={t('common.edit')} size="small" display="secondary" disabled={blocked}
                    onPress={async () => { if (!blocked) await props.onEditPlan?.(planValue, revision); }} />} /> : null}
        </ItemGroup></ListPresentationProvider>;
    // A sheet sizes a Wait to its content and scrolls it as a whole; a pane pins every decision.
    const pinned = props.primaryActionPlacement === 'footer' && (!props.waitForYou || props.fillHeight !== true);
    const fill = props.fillHeight === true ? styles.filled : styles.fitted;
    return <View testID={prefix} style={[styles.root, pinned ? fill : null]}>
        {pinned ? <ScrollView testID={`${prefix}-scroll`} style={fill}
            // The body under a pane's header: its scroll drives that header's shade.
            onScroll={paneHeaderScroll ? (event) => paneHeaderScroll.reportTopDistance(event.nativeEvent.contentOffset.y) : undefined}
            scrollEventThrottle={16} keyboardShouldPersistTaps="handled">{body}{props.belowResult}</ScrollView> : <>{body}{props.belowResult}</>}
        {props.primaryActionPlacement === 'footer' ? primaryAction : null}
    </View>;
}
