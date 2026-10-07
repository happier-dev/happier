import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { classifyWorkflowHoldV1, type WorkflowInvocationLifecycleV1, type WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { sameStrictJsonValue, StrictJsonValueSchema, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowResultContract } from '@happier-dev/protocol/workflows/workflowV1';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { decodeExecutionRunResultObservation } from '@happier-dev/protocol/execution/runs/resultContract';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
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
import { workStatusSurfaceStyle } from '@/components/work/status/workStatusTreatment';
import { projectWorkflowRunInputFields } from '@/sync/domains/workflows/workflowAuthoring';
import { formatWorkflowInputValue, parseWorkflowInputTextDraft } from '@/sync/domains/workflows/workflowInputText';
import { readWorkflowPlanResult } from '@/sync/domains/workflows/workflowPlanReview';
import { t } from '@/text';
import { useWorkflowCardModal } from './useWorkflowCardModal';

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
    canGenerate?: boolean;
    readOnly?: boolean;
    parentPaused?: boolean;
    machineReachable?: boolean;
    machineName?: string | null;
    resultSourceLabel?: string;
    primaryActionPlacement?: 'inline' | 'footer';
    testIDPrefix?: string;
}>;

const styles = StyleSheet.create((theme) => ({
    root: { minWidth: 0 },
    filled: { flex: 1, minHeight: 0 },
    actions: { gap: theme.margins.sm, alignItems: 'stretch' },
    secondary: { color: theme.colors.text.secondary },
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
function serialize(value: JsonValue | undefined, contract: WorkflowResultContract | undefined): string {
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

type ReviewValueProps = Readonly<{ value: JsonValue; contract: WorkflowResultContract | undefined; testIDPrefix: string }>;

/** Both the bounded reading and full inspection render the same exact value with the established viewers. */
function WorkflowReviewValue({ value, contract, testIDPrefix: prefix }: ReviewValueProps): React.ReactElement {
    const plan = contract?.kind === 'json' ? readWorkflowPlanResult(value) : null;
    const fields = objectValue(value);
    return plan ? <SectionContentRow><MarkdownView testID={`${prefix}-plan-document`} markdown={plan.document} /></SectionContentRow>
        : fields ? <>{Object.entries(fields).map(([name, fieldValue]) =>
            <Item key={name} title={(contract?.kind === 'json' ? contract.schema.properties?.[name]?.title : undefined) ?? name}
                showChevron={false} accessoryLayout="stacked"
                rightElement={<Text selectable testID={`${prefix}-value-${name}`}>{formatWorkflowInputValue(fieldValue)}</Text>} />)}</>
            : <SectionContentRow><Text selectable testID={`${prefix}-value`}>{serialize(value, contract)}</Text></SectionContentRow>;
}

function WorkflowReviewFullValue(props: ReviewValueProps): React.ReactElement {
    return <View testID={`${props.testIDPrefix}-value`}><ListPresentationProvider value="page"><ItemGroup>
        <WorkflowReviewValue {...props} />
        <Item testID={`${props.testIDPrefix}-copy`} title={t('common.copy')} copy={serialize(props.value, props.contract)} showChevron={false} />
    </ItemGroup></ListPresentationProvider></View>;
}

/** Exact-result presentation. The caller owns drafts, Actions, authority and Plan admission. */
export function WorkflowReviewCard(props: WorkflowReviewCardProps): React.ReactElement {
    const prefix = props.testIDPrefix ?? 'workflow-review';
    const { theme } = useUnistyles();
    // Reading a publication does not silently swap the value under the person's next decision.
    const [localReading, setLocalReading] = React.useState<WorkflowReviewReading>(() => ({ value: props.progress.result, revision: props.contentRevision }));
    const reading = props.reading ?? localReading;
    const setReading = props.onChangeReading ?? setLocalReading;
    const [openField, setOpenField] = React.useState<string | null>(null);
    const [keptNewerRevision, setKeptNewerRevision] = React.useState<string | null>(null);
    const [fullValue, setFullValue] = React.useState<ReviewValueProps | null>(null);
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
    const blocked = props.pending === true || props.readOnly === true;
    const generatePrimary = !props.waitForYou && !valid && props.draft === undefined && props.canGenerate !== false;
    const readiness = classifyWorkflowHoldV1({ lifecycle: props.lifecycle ?? 'waiting_for_review',
        isCurrent: props.isCurrent ?? true, progress: props.progress });
    const held = readiness !== 'resolved';
    const fields = simpleFields(props.contract);
    const editing = supplied || (props.waitForYou && !noValueNeeded && held && !props.readOnly);
    const changed = props.contentRevision !== revision;
    const plan = !props.waitForYou && props.contract?.kind === 'json' && shown !== undefined ? readWorkflowPlanResult(shown) : null;
    const planValue = plan !== null && valid ? shown : undefined;
    const issues = validation && !validation.ok ? validation.issues ?? [] : [];
    const title = props.waitForYou ? t('workflows.review.waitTitle') : editing ? t('workflows.review.editsTitle')
        : plan ? t('workflows.review.planTitle') : valid ? t('workflows.review.title') : t('workflows.review.noValue');
    const updateText = (text: string) => props.onChangeDraft({ text, contentRevision: revision });
    const showNewer = () => {
        if (props.pending === true) return;
        setReading({ value: props.progress.result, revision: props.contentRevision });
        props.onChangeDraft(undefined);
        setKeptNewerRevision(null);
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
    const seedEdit = () => { if (!blocked) updateText(serialize(reading.value, props.contract)); };
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
    const error = editing && !valid && !noValueNeeded && hasFieldError ? t('workflows.review.invalid') : null;
    const decisionEditor = decisionChoices === null ? null : decisionChoices.length >= 2 && decisionChoices.length <= 4
        ? <SegmentedChoiceItem title={t('workflows.input.result')} subtitle={valueError ?? undefined} disabled={blocked}
            value={typeof shown === 'string' ? shown : ''} testIDPrefix={`${prefix}-decision`}
            options={decisionChoices.map((value) => ({ id: value, label: value }))} onChange={selectDecision} />
        : <DropdownMenu testID={`${prefix}-decision`} open={openField === 'decision'}
            onOpenChange={(open) => { if (!blocked) setOpenField(open ? 'decision' : null); }}
            itemTrigger={{ title: t('workflows.input.result'), subtitle: valueError ?? undefined, itemProps: { disabled: blocked } }}
            items={decisionChoices.map((value) => ({ id: value, title: value }))}
            selectedId={typeof shown === 'string' ? shown : null} onSelect={selectDecision} />;
    const primaryAction = held && !props.readOnly ? <SectionContentRow testID={`${prefix}-primary`} showDivider={false}>
        <View style={styles.actions}>
            <RoundButton testID={`${prefix}-${generatePrimary ? 'generate' : 'use'}`} size="normal"
                disabled={blocked || (!generatePrimary && !valid && !noValueNeeded)} loading={props.pending} titleNumberOfLines="complete"
                title={generatePrimary ? t('workflows.review.generate') : props.waitForYou ? noValueNeeded ? t('workflows.review.continue') : t('workflows.review.useValues')
                    : plan ? t('workflows.review.usePlan') : t('workflows.review.useResult')}
                onPress={generatePrimary ? generate : use} />
            {error ? <Text testID={`${prefix}-validation`} style={[styles.error, styles.footnote]} accessibilityRole="alert">{error}</Text> : null}
            {!noValueNeeded ? <Text style={[styles.secondary, styles.footnote]}>{generatePrimary ? props.parentPaused ? t('workflows.review.startsResume')
                : t('workflows.review.generateBody') : plan ? t('workflows.review.usePlanBody') : t('workflows.review.useBody')}</Text> : null}
            {editing && !props.waitForYou ? <RoundButton testID={`${prefix}-cancel`} size="small" display="inverted"
                title={t('common.cancel')} disabled={blocked} onPress={() => { if (!blocked) props.onChangeDraft(undefined); }} /> : null}
            {props.parentPaused ? <Text style={styles.secondary}>{t('workflows.review.acceptedPaused')}</Text> : null}
        </View>
    </SectionContentRow> : null;
    // The hold card is one page section: its title and state line above, one sheet that carries the
    // shared needs-you ring and tint while the hold waits (07 §3 "Status quiet, one tone owner").
    const body = <ListPresentationProvider value="page"><ItemGroup title={title} description={props.waitForYou ? t('workflows.review.waitBody')
            : editing ? t('workflows.review.editsBody') : held ? t('workflows.review.heldBody') : undefined}
            containerStyle={held ? workStatusSurfaceStyle('attention') : undefined}>
            {changed && (!supplied || keptNewerRevision !== props.contentRevision) ? <SectionContentRow testID={`${prefix}-newer`}>
                <Text accessibilityLiveRegion="polite">{t('workflows.review.newer')}</Text>
                <View style={styles.actions}>{supplied ? <>
                    <RoundButton testID={`${prefix}-keep-edits`} title={t('workflows.review.keepMyEdits')} size="small"
                        display="secondary" disabled={blocked} onPress={() => { if (!blocked) setKeptNewerRevision(props.contentRevision); }} />
                    <RoundButton testID={`${prefix}-use-newer`} title={t('workflows.review.useNewer')} size="small"
                        display="inverted" disabled={blocked} onPress={showNewer} />
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
                const label = schema.title ?? field.definition.name;
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
                    if (choices.length >= 2 && choices.length <= 4) return <SegmentedChoiceItem key={field.definition.name}
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
                        multiline={field.definition.valueType === 'string'}
                        keyboardType={field.definition.valueType === 'number' ? 'numeric' : undefined}
                        onChangeText={(text) => {
                            const parsed = parseWorkflowInputTextDraft(field.definition, text);
                            changeField(field.definition.name, parsed.invalid ? text : field.definition.valueType === 'string' ? text : parsed.value);
                        }} />} />;
            }) : <Item title={t('workflows.input.result')} showChevron={false} accessoryLayout="stacked"
                rightElement={<FieldTextInput testID={`${prefix}-editor`} value={props.draft?.text ?? serialize(reading.value, props.contract)}
                    onChangeText={(text) => { if (!blocked) { touch(VALUE_FIELD); updateText(text); } }} accessibilityLabel={t('workflows.input.result')}
                    error={valueError} editable={!blocked} multiline monospace={props.contract !== undefined && props.contract.kind !== 'text'} />} />)
                : shown !== undefined ? <>
                    <View testID={`${prefix}-preview`} style={styles.preview}>
                        <ScrollView testID={`${prefix}-preview-scroll`} style={styles.previewScroll} nestedScrollEnabled
                            keyboardShouldPersistTaps="handled" onLayout={previewFades.onViewportLayout}
                            onContentSizeChange={previewFades.onContentSizeChange} onScroll={previewFades.onScroll} scrollEventThrottle={16}>
                            <WorkflowReviewValue value={shown} contract={props.contract} testIDPrefix={prefix} />
                        </ScrollView>
                        <ScrollEdgeFades color={held ? theme.colors.state.warning.background : theme.colors.surface.base}
                            edges={previewFades.visibility} />
                    </View>
                    <Item testID={`${prefix}-show-full`} title={t(plan ? 'workflows.review.showFullPlan' : 'workflows.review.showFullResult')}
                        onPress={() => setFullValue({ value: shown, contract: props.contract, testIDPrefix: `${prefix}-full` })} />
                </> : null}
            {shown !== undefined && !editing ? <Item testID={`${prefix}-copy`} title={t('common.copy')}
                subtitle={props.resultSourceLabel} copy={serialize(shown, props.contract)} showChevron={false} /> : null}
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
            {props.primaryActionPlacement !== 'footer' ? primaryAction : null}
            {!props.readOnly && held && !editing && !props.waitForYou ? <Item title={t('workflows.review.editResult')} showChevron={false}
                rightElement={<RoundButton testID={`${prefix}-edit`} title={t('common.edit')} size="small" display="secondary" disabled={blocked} onPress={seedEdit} />} /> : null}
            {!props.readOnly && held && !props.waitForYou && props.canGenerate !== false && !generatePrimary ? <Item title={t('workflows.review.generate')}
                subtitle={props.parentPaused ? t('workflows.review.startsResume') : t('workflows.review.generateBody')} showChevron={false}
                accessoryLayout="adaptive" rightElement={<RoundButton testID={`${prefix}-generate`} title={t('workflows.review.generate')}
                    titleNumberOfLines="complete" size="small" display={!valid && !editing ? 'default' : 'secondary'} disabled={blocked} onPress={generate} />} /> : null}
            {!props.readOnly && held && !props.waitForYou && props.onDiscuss ? <Item title={t('workflows.review.discuss')}
                subtitle={t('workflows.review.discussBody')} showChevron={false}
                rightElement={<RoundButton testID={`${prefix}-discuss`} title={t('workflows.review.discuss')} size="small" display="inverted"
                    disabled={props.pending} onPress={props.onDiscuss} />} /> : null}
            {!props.readOnly && planValue !== undefined && props.onRunPlan && props.planProposalValid === true && !props.startedPlanRunId ? <Item
                title={t(props.earlierPlanRunId ? 'workflows.review.runNewProposal' : 'workflows.review.runPlan')} subtitle={t('workflows.review.runPlanBody')} showChevron={false} accessoryLayout="adaptive"
                rightElement={<RoundButton testID={`${prefix}-plan-run`} title={t(props.earlierPlanRunId ? 'workflows.review.runNewProposal' : 'workflows.review.runPlan')} titleNumberOfLines="complete" size="small" display="secondary" disabled={blocked}
                    onPress={async () => { if (!blocked) await props.onRunPlan?.(planValue, revision); }} />} /> : null}
            {!props.readOnly && planValue !== undefined && props.onEditPlan ? <Item title={t('workflows.review.editPlan')}
                subtitle={props.planProposalValid ? t('workflows.review.editPlanBody') : t('workflows.review.editPlanFallback')} showChevron={false} accessoryLayout="adaptive"
                rightElement={<RoundButton testID={`${prefix}-plan-edit`} title={t('common.edit')} size="small" display="secondary" disabled={blocked}
                    onPress={async () => { if (!blocked) await props.onEditPlan?.(planValue, revision); }} />} /> : null}
        </ItemGroup></ListPresentationProvider>;
    return <View testID={prefix} style={[styles.root, props.primaryActionPlacement === 'footer' ? styles.filled : null]}>
        {props.primaryActionPlacement === 'footer' ? <ScrollView testID={`${prefix}-scroll`} style={styles.filled}
            keyboardShouldPersistTaps="handled">{body}</ScrollView> : body}
        {props.primaryActionPlacement === 'footer' ? primaryAction : null}
    </View>;
}
