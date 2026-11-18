import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { ScrollView, StyleSheet as RNStyleSheet, View } from 'react-native';

import { PopoverBoundaryProvider } from '@/components/ui/popover/PopoverBoundary';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
    resolveEffectiveWorkflowStepExecution,
    resolveWorkflowIssueBlockId,
} from '@/sync/domains/workflows/workflowAuthoring';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import {
    findWorkflowBlockListRef,
    getWorkflowBlockList,
    setWorkflowBlockOnlyWhen,
    setWorkflowLeafPauseForReview,
    setWorkflowStepExecutionField,
    setWorkflowStepExecutionTarget,
    setWorkflowStepTimeout,
    updateWorkflowBlock,
} from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type {
    WorkflowBlock,
    WorkflowLeafExecutionTargetV1,
    WorkflowRunWhenV1,
    WorkflowStep,
} from '@happier-dev/protocol/workflows/workflowV1';
import { WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';
import type { WorkflowCondition } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { SessionAuthoringControls } from '@/components/sessions/authoring/controls/SessionAuthoringControls';

import type { WorkflowRunAsTargetKind } from '../run/workflowRunAsTargets';
import { findWorkflowActionSpec } from '@/components/workflows/presentation/workflowActionCatalog';
import { formatWorkflowConditionSentence } from '../presentation/workflowConditionPresentation';
import { WorkflowConditionEditor } from './WorkflowConditionEditor';
import { formatWorkflowContinuitySummary, useWorkflowContinuedSessionLabel, WorkflowContinuityControls } from './WorkflowContinuityControls';
import { formatWorkflowGroupSentence, WorkflowGroupOptions } from './WorkflowGroupEditor';
import type { WorkflowInspectorProps } from './WorkflowInspector';
import { formatWorkflowLoopSentence, WorkflowLoopOptions } from './WorkflowLoopEditor';
import { formatWorkflowResultSummary } from './WorkflowStepDataEditor';
import { WorkflowResultFieldsEditor } from './WorkflowResultFieldsEditor';
import {
    WORKFLOW_SESSION_FIELD_IDS_BESIDE_ENGINE,
    WorkflowFieldInheritance,
    WorkflowStepTimeoutField,
} from './WorkflowStepInspector';
import { listWorkflowStepSessionChanges } from './WorkflowStepCardChips';
import { workflowEditorStyles } from './workflowEditorStyles';
import { NO_DISCLOSURE, WorkflowInspectorGroup } from './workflowInspectorGroup';
import { renderWorkflowCardFieldRow } from './workflowCardFieldRow';
import { WorkflowStepWorkspaceField } from './WorkflowProjectTargetControl';
import { buildWorkflowStepWorkspace } from './workflowStepWorkspace';
import { WorkflowRunWhenOption } from './WorkflowRunWhenConnector';
import {
    readWorkflowNotifyReportOffer,
    setWorkflowNotifyReportOffer,
    WORKFLOW_NOTIFY_ME_ACTION_ID,
} from './workflowNotifyReportCondition';
import { readWorkflowEngineChoiceV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';

/**
 * Step options: the block subject of the one inspector content (04 §5.2), for
 * every block kind. A header names the block (and, for an Agent step, whether
 * it differs from the workflow) with Done in the popover; Result and Only run
 * when push their editors into the same surface with Back.
 *
 * - Agent step: Conversation, Workspace (field selects with "Workflow default ·
 *   {value}" first), Agent and model, Runs in, Review before continuing,
 *   Result, Only run when, Advanced.
 * - Action: Only run when, Result (defined by the Action), Advanced.
 * - Run a workflow: Only run when, Result (what the child returns).
 * - Wait for you: Result (what the person supplies), Only run when.
 * - Repeat / Side by side: the container's own options, Only run when.
 * - If: its condition.
 *
 * Every edit goes through the protocol draft operations; nothing here keeps a
 * copy of the draft.
 */

type OptionsPage = 'main' | 'result' | 'condition';

const styles = StyleSheet.create((theme) => ({
    /** The host bounds the surface's height; the header stays put and only the page scrolls. */
    root: {
        flexShrink: 1,
        minHeight: 0,
    },
    page: {
        flexShrink: 1,
        minHeight: 0,
    },
    subjectHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s8,
        borderBottomWidth: RNStyleSheet.hairlineWidth,
        borderBottomColor: 'transparent',
    },
    /** Content has scrolled beneath the pinned header: the header gains its divider. */
    subjectHeaderScrolled: {
        borderBottomColor: theme.colors.border.default,
    },
    subjectText: {
        flexShrink: 1,
        flexGrow: 1,
        minWidth: 0,
    },
    subjectTitle: {
        ...Typography.variant('heading', 'semiBold'),
        color: theme.colors.text.primary,
    },
    subjectLocation: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    trailing: {
        marginLeft: 'auto',
    },
}));

function HeaderAction(props: Readonly<{ label: string; onPress: () => void; testID: string; trailing?: boolean }>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            onPress={props.onPress}
            style={(state) => [
                props.trailing === true ? styles.trailing : null,
                workflowEditorStyles.actionTarget,
                state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
            ]}
        >
            <Text style={workflowEditorStyles.metaAction}>{props.label}</Text>
        </HappierPressable>
    );
}

function blockTitle(block: WorkflowBlock): string {
    return workflowBlockReferenceLabel(block);
}

function subPageTitle(page: OptionsPage, block: WorkflowBlock): string | null {
    if (page === 'result') return t('workflows.page.inspector.resultTitle');
    if (page === 'condition') return t('workflows.condition.whenTitle');
    return null;
}

function blockCondition(block: WorkflowBlock): WorkflowCondition | undefined {
    return block.kind === 'if' ? block.when : block.onlyWhen;
}

/**
 * The one settings surface's frame (owner 2026-11-15: one settings popover, two scopes): a pinned
 * header — Back on a sub-page, what it edits and where, Done in the popover — over the page that
 * scrolls. Workflow settings and Step options both draw it.
 */
export function WorkflowSettingsFrame(props: Readonly<{
    title: string;
    /** Under the title: a sub-page's subject, or what the settings change. */
    location?: string;
    onBack?: () => void;
    onDone?: () => void;
    /** Changes with each page, so a page opens at its top. */
    pageKey: string;
    testIDPrefix: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const { testIDPrefix } = props;
    const [scrolled, setScrolled] = React.useState(false);
    // Each page opens at its top, so the header starts without its divider.
    const [shownPage, setShownPage] = React.useState(props.pageKey);
    if (shownPage !== props.pageKey) { setShownPage(props.pageKey); setScrolled(false); }
    // The frame bounds every menu opened inside it (a select's choices, the Workspace picker), so they open
    // within the panel instead of past its edges (WF-ACCEPT-1118 item 1).
    const frameRef = React.useRef<View>(null);
    return (
        <PopoverBoundaryProvider boundaryRef={frameRef}>
        <View ref={frameRef} collapsable={false} testID={`${testIDPrefix}-options`} style={styles.root}>
            <View style={[styles.subjectHeader, scrolled ? styles.subjectHeaderScrolled : null]}>
                {props.onBack === undefined ? null : (
                    <HeaderAction label={t('workflows.page.inspector.back')} onPress={props.onBack} testID={`${testIDPrefix}-back`} />
                )}
                <View style={styles.subjectText}>
                    <Text style={styles.subjectTitle} numberOfLines={1}>{props.title}</Text>
                    {props.location === undefined ? null : (
                        <Text style={styles.subjectLocation} numberOfLines={1}>{props.location}</Text>
                    )}
                </View>
                {props.onDone === undefined ? null : (
                    <HeaderAction label={t('common.done')} onPress={props.onDone} testID={`${testIDPrefix}-done`} trailing />
                )}
            </View>
            <ScrollView
                key={props.pageKey}
                testID={`${testIDPrefix}-options-page`}
                style={styles.page}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                scrollEventThrottle={64}
                onScroll={(event) => setScrolled(event.nativeEvent.contentOffset.y > 0)}
            >
                {props.children}
            </ScrollView>
        </View>
        </PopoverBoundaryProvider>
    );
}

export function WorkflowBlockOptions(props: WorkflowInspectorProps & Readonly<{ block: WorkflowBlock }>): React.ReactElement {
    const { block, draft, onChange, testIDPrefix } = props;
    const [page, setPage] = React.useState<OptionsPage>('main');
    const subPage = subPageTitle(page, block);

    return (
        <WorkflowSettingsFrame
            // A sub-page leads with what it edits; the block it belongs to becomes its location, under the title (lab I1).
            title={subPage ?? (block.kind === 'if' ? t('workflows.condition.whenTitle') : blockTitle(block))}
            {...(subPage !== null ? { location: blockTitle(block) }
                : block.kind === 'step' ? { location: t('workflows.page.stepSettingsSubtitle') }
                    : {})}
            {...(page === 'main' ? {} : { onBack: () => setPage('main') })}
            {...(props.presentation === 'popover' && props.onDone !== undefined ? { onDone: props.onDone } : {})}
            pageKey={page}
            testIDPrefix={testIDPrefix}
        >
            {page === 'condition' ? (
                <ItemGroup>
                    <SectionContentRow testID={`${testIDPrefix}-condition-row`}>
                        <WorkflowConditionEditor
                            label={block.kind === 'if' ? t('workflows.condition.ifWhen') : t('workflows.condition.onlyWhen')}
                            condition={blockCondition(block)}
                            draft={draft}
                            consumerBlockId={block.id}
                            required={block.kind === 'if'}
                            onChange={(condition) => {
                                if (block.kind === 'if') {
                                    if (condition !== undefined) {
                                        onChange(updateWorkflowBlock(draft, block.id, (current) => (
                                            current.kind === 'if' ? { ...current, when: condition } : current
                                        )));
                                    }
                                    return;
                                }
                                onChange(setWorkflowBlockOnlyWhen(draft, block.id, condition));
                            }}
                            testIDPrefix={`${testIDPrefix}-condition`}
                        />
                    </SectionContentRow>
                </ItemGroup>
            ) : page === 'result' ? (
                <ResultPage {...props} />
            ) : (
                <MainPage {...props} onOpenPage={setPage} />
            )}
        </WorkflowSettingsFrame>
    );
}

/** Whether a block follows another in its list, so the previous step's outcome can decide it. */
function followsAnotherBlock(draft: WorkflowEditorDraft, blockId: string): boolean {
    const ref = findWorkflowBlockListRef(draft, blockId);
    const list = ref === null ? null : getWorkflowBlockList(draft, ref);
    return (list?.findIndex((candidate) => candidate.id === blockId) ?? 0) > 0;
}

/**
 * When the block runs, in one group: the previous step's outcome (Run when) and its own condition
 * (Only run when), plus Notify me's "only if the agent reported something" offer over that same
 * condition. Every row edits the block itself; none keeps a second state.
 */
function WhenItRunsGroup(props: Readonly<{
    draft: WorkflowEditorDraft;
    block: WorkflowBlock;
    onChange: (next: WorkflowEditorDraft) => void;
    onOpenCondition: () => void;
    testIDPrefix: string;
    children?: React.ReactNode;
}>): React.ReactElement {
    const { draft, block, onChange, testIDPrefix } = props;
    const runWhen = 'runWhen' in block ? block.runWhen : undefined;
    const offersRunWhen = block.kind !== 'if' && (runWhen !== undefined || followsAnotherBlock(draft, block.id));
    return (
        <ItemGroup>
            {props.children}
            {offersRunWhen ? (
                <WorkflowRunWhenOption
                    value={runWhen}
                    testIDPrefix={`${testIDPrefix}-run-when`}
                    onChange={(next: WorkflowRunWhenV1) => onChange(updateWorkflowBlock(draft, block.id, (current) => {
                        if (next !== 'success') return { ...current, runWhen: next };
                        const { runWhen: _dropped, ...rest } = current as WorkflowBlock & { runWhen?: WorkflowRunWhenV1 };
                        return rest as WorkflowBlock;
                    }))}
                />
            ) : null}
            <OnlyRunWhenRow draft={draft} block={block} onOpen={props.onOpenCondition} testIDPrefix={testIDPrefix} />
            {block.kind === 'action' && block.actionId === WORKFLOW_NOTIFY_ME_ACTION_ID
                ? <NotifyReportRow draft={draft} block={block} onChange={onChange} testIDPrefix={testIDPrefix} /> : null}
        </ItemGroup>
    );
}

/** Notify me's quiet offer (D7): a switch over the Only run when condition, never a state of its own. */
function NotifyReportRow(props: Readonly<{
    draft: WorkflowEditorDraft;
    block: WorkflowActionLeafV1;
    onChange: (next: WorkflowEditorDraft) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { draft, block } = props;
    const offer = readWorkflowNotifyReportOffer(draft, block);
    return (
        <Item
            testID={`${props.testIDPrefix}-only-reported-row`}
            title={t('sessionWork.scheduled.notifyOnlyReported')}
            subtitle={!offer.available ? t('sessionWork.scheduled.notifyOnlyReportedNeedsResult')
                : offer.canonical !== null ? t('sessionWork.scheduled.notifyOnlyReportedDescription') : undefined}
            showChevron={false}
            rightElement={(
                <Switch
                    testID={`${props.testIDPrefix}-only-reported`}
                    accessibilityLabel={t('sessionWork.scheduled.notifyOnlyReported')}
                    value={offer.on}
                    disabled={!offer.available}
                    onValueChange={!offer.available ? undefined : (enabled) => props.onChange(
                        setWorkflowBlockOnlyWhen(draft, block.id, setWorkflowNotifyReportOffer(draft, block, enabled)),
                    )}
                />
            )}
        />
    );
}

/** "Only run when · Always" or the condition sentence; the chevron pushes the condition editor. */
function OnlyRunWhenRow(props: Readonly<{
    draft: WorkflowEditorDraft;
    block: WorkflowBlock;
    onOpen: () => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const condition = blockCondition(props.block);
    return (
        <Item
            testID={`${props.testIDPrefix}-only-when`}
            title={props.block.kind === 'if' ? t('workflows.condition.ifWhen') : t('workflows.condition.onlyWhen')}
            subtitle={condition === undefined
                ? `${t('workflows.condition.always')} · ${t('workflows.condition.addCondition')}`
                : formatWorkflowConditionSentence(props.draft, condition)}
            onPress={props.onOpen}
        />
    );
}

function MainPage(props: WorkflowInspectorProps & Readonly<{
    block: WorkflowBlock;
    onOpenPage: (page: OptionsPage) => void;
}>): React.ReactElement {
    const { block, draft, onChange, testIDPrefix } = props;
    if (props.documentEditable === false && block.kind !== 'step') return <ItemGroup>
        {block.kind === 'loop' || block.kind === 'parallel' ? <SectionContentRow>
            <Text style={workflowEditorStyles.metaText}>{block.kind === 'loop' ? formatWorkflowLoopSentence(draft, block) : formatWorkflowGroupSentence(block)}</Text>
        </SectionContentRow> : null}
        {(block.kind === 'wait' || block.kind === 'action' || block.kind === 'workflow') ? <Item
            title={t('workflows.page.inspector.resultTitle')} subtitle={'result' in block ? formatWorkflowResultSummary(block.result) : t('workflows.page.inspector.resultFromWorkflow', { workflow: workflowBlockReferenceLabel(block) })}
            mode="info" /> : null}
        <SectionContentRow><WorkflowConditionEditor editable={false}
            label={block.kind === 'if' ? t('workflows.condition.ifWhen') : t('workflows.condition.onlyWhen')}
            condition={blockCondition(block)} draft={draft} consumerBlockId={block.id} onChange={() => {}} testIDPrefix={`${testIDPrefix}-condition`} /></SectionContentRow>
    </ItemGroup>;
    const onlyRunWhen = (
        <WhenItRunsGroup draft={draft} block={block} onChange={onChange}
            onOpenCondition={() => props.onOpenPage('condition')} testIDPrefix={testIDPrefix} />
    );

    switch (block.kind) {
        case 'step':
            return <StepMainPage {...props} step={block} />;
        case 'action': {
            const spec = findWorkflowActionSpec(block.actionId);
            return (
                <>
                    {onlyRunWhen}
                    <ItemGroup>
                        <Item
                            testID={`${testIDPrefix}-result`}
                            title={t('workflows.page.inspector.resultTitle')}
                            subtitle={t('workflows.page.inspector.resultFromAction', { action: spec?.title ?? block.actionId })}
                            showChevron={false}
                        />
                    </ItemGroup>
                    <AdvancedGroup {...props} />
                </>
            );
        }
        case 'workflow':
            return (
                <>
                    {onlyRunWhen}
                    <ItemGroup>
                        <Item
                            testID={`${testIDPrefix}-result`}
                            title={t('workflows.page.inspector.resultTitle')}
                            subtitle={t('workflows.page.inspector.resultFromWorkflow', { workflow: workflowBlockReferenceLabel(block) })}
                            showChevron={false}
                        />
                    </ItemGroup>
                </>
            );
        case 'wait':
            return (
                <>
                    <ItemGroup>
                        <Item
                            testID={`${testIDPrefix}-result`}
                            title={t('workflows.page.inspector.resultTitle')}
                            subtitle={formatWorkflowResultSummary(block.result)}
                            onPress={() => props.onOpenPage('result')}
                        />
                    </ItemGroup>
                    {onlyRunWhen}
                </>
            );
        case 'loop':
            return (
                <>
                    <WorkflowLoopOptions draft={draft} block={block} onChange={onChange} testIDPrefix={testIDPrefix} />
                    {onlyRunWhen}
                </>
            );
        case 'parallel':
            return (
                <>
                    <WorkflowGroupOptions draft={draft} block={block} onChange={onChange} testIDPrefix={testIDPrefix} />
                    {onlyRunWhen}
                </>
            );
        case 'if':
            return (
                <ItemGroup>
                    <SectionContentRow testID={`${testIDPrefix}-condition-row`}>
                        <WorkflowConditionEditor
                            label={t('workflows.condition.ifWhen')}
                            condition={block.when}
                            draft={draft}
                            consumerBlockId={block.id}
                            required
                            onChange={(condition) => {
                                if (condition === undefined) return;
                                onChange(updateWorkflowBlock(draft, block.id, (current) => (
                                    current.kind === 'if' ? { ...current, when: condition } : current
                                )));
                            }}
                            testIDPrefix={`${testIDPrefix}-condition`}
                        />
                    </SectionContentRow>
                </ItemGroup>
            );
    }
}

/** The Result destination: a step's or Wait's result shape, pushed into the same surface (04 §6.1). */
function ResultPage(props: WorkflowInspectorProps & Readonly<{ block: WorkflowBlock }>): React.ReactElement | null {
    const { block } = props;
    if (block.kind !== 'step' && block.kind !== 'wait') return null;
    return (
        <WorkflowResultFieldsEditor
            draft={props.draft}
            block={block}
            onChange={props.onChange}
            editable={props.documentEditable !== false}
            testIDPrefix={props.testIDPrefix}
        />
    );
}

/** Advanced: the result-wait deadline, a quiet summary until set or opened. */
function AdvancedGroup(props: WorkflowInspectorProps & Readonly<{ block: WorkflowBlock }>): React.ReactElement | null {
    const { block, draft, onChange, testIDPrefix } = props;
    if (block.kind !== 'step' && block.kind !== 'action') return null;
    const issues = (props.validation?.issues ?? []).filter((issue) => resolveWorkflowIssueBlockId(draft, issue) === block.id);
    return (
        <WorkflowInspectorGroup
            disclosure={props.groupDisclosure ?? NO_DISCLOSURE}
            {...(props.onChangeGroupDisclosure === undefined ? {} : { onChangeDisclosure: props.onChangeGroupDisclosure })}
            groupId={`block:${block.id}:advanced`}
            title={t('workflows.page.inspector.advancedTitle')}
            summary={block.timeoutMs === undefined || !Number.isFinite(block.timeoutMs)
                ? t('workflows.editor.noDeadline')
                : t('workflows.page.inspector.deadline', { ms: block.timeoutMs })}
            attention={issues.some((issue) => issue.path.endsWith('/timeoutMs'))
                || (block.timeoutMs !== undefined && !Number.isFinite(block.timeoutMs))}
            valueSet={block.timeoutMs !== undefined}
            testID={`${testIDPrefix}-group-advanced`}
        >
            <SectionContentRow testID={`${testIDPrefix}-timeout-row`}>
                <WorkflowStepTimeoutField
                    timeoutMs={block.timeoutMs}
                    onChange={(timeoutMs) => onChange(setWorkflowStepTimeout(draft, block.id, timeoutMs))}
                    testIDPrefix={testIDPrefix}
                />
            </SectionContentRow>
        </WorkflowInspectorGroup>
    );
}

function runsInLabel(kind: WorkflowRunAsTargetKind | WorkflowLeafExecutionTargetV1['kind']): string {
    return kind === 'detached_run' ? t('workflows.page.sections.aBackgroundRun') : t('workflows.page.sections.aSession');
}

function StepMainPage(props: WorkflowInspectorProps & Readonly<{
    block: WorkflowBlock;
    step: WorkflowStep;
    onOpenPage: (page: OptionsPage) => void;
}>): React.ReactElement {
    const { draft, onChange, step, testIDPrefix } = props;
    const effectiveExecution = resolveEffectiveWorkflowStepExecution(draft, step);
    const continuedSessionLabel = useWorkflowContinuedSessionLabel(effectiveExecution.conversation);
    const workspace = React.useMemo(() => buildWorkflowStepWorkspace({ draft, step, onChange }), [draft, onChange, step]);
    if (props.documentEditable === false) return <>
        <ItemGroup title={t('workflows.page.sections.conversationTitle')}><SectionContentRow>
            <Text style={workflowEditorStyles.metaText}>{formatWorkflowContinuitySummary({ draft,
                conversation: effectiveExecution.conversation, workspace: effectiveExecution.workspace, existingSessions: props.existingSessions,
                sessionLabel: continuedSessionLabel })}</Text>
        </SectionContentRow></ItemGroup>
        <ItemGroup>
            <Item title={t('workflows.page.inspector.runsIn')} subtitle={runsInLabel(step.execution?.executionTarget?.kind ?? props.executionTarget ?? 'session')} mode="info" />
            <Item title={t('workflows.page.inspector.reviewTitle')} subtitle={t(step.pauseForReview ? 'common.yes' : 'common.no')} mode="info" />
            <Item title={t('workflows.page.inspector.resultTitle')} subtitle={formatWorkflowResultSummary(step.result)} mode="info" />
            <SectionContentRow><WorkflowConditionEditor editable={false} label={t('workflows.condition.onlyWhen')}
                condition={step.onlyWhen} draft={draft} consumerBlockId={step.id} onChange={() => {}} testIDPrefix={`${testIDPrefix}-condition`} /></SectionContentRow>
            <Item title={t('workflows.editor.timeoutTitle')} subtitle={step.timeoutMs === undefined ? t('workflows.editor.noDeadline')
                : t('workflows.page.inspector.deadline', { ms: step.timeoutMs })} mode="info" />
        </ItemGroup>
        <ItemGroup title={t('workflows.page.sections.agentTitle')}>
            <SessionAuthoringControls presentation="fields" disabled fields={WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS}
                engineFieldTitle={null}
                values={effectiveExecution} engine={readWorkflowEngineChoiceV1(draft.defaults, step.execution)} workflowRoles={draft.roles}
                onChangeField={() => {}} onChangeFields={() => {}} onChangeEngine={() => {}}
                facts={props.authoringFacts} testIDPrefix={`${testIDPrefix}-control`} />
        </ItemGroup>
    </>;

    // Runs in (U5 precedence): an explicit step choice; else a session-bound
    // conversation decides; else the workflow default.
    const ownTarget = step.execution?.executionTarget?.kind;
    const workflowTarget = props.executionTarget ?? 'session';
    const sessionBound = effectiveExecution.conversation?.kind === 'existing_session'
        || effectiveExecution.conversation?.kind === 'origin_session';
    const detachedUnavailable = props.runAsTargets?.find((target) => target.kind === 'detached_run' && !target.available);
    const insideEvaluator = isLoopEvaluator(draft.blocks, step.id);

    // The step's options (round 1116b, recomposed by the design owner 11-18): who runs it as labelled field
    // selects on the one label track (the same owner and pickers as the How card; changed rows are marked and
    // lead with "Use workflow's"), then where it runs and works, then when it runs, then this step's own choices.
    // The engine is the card header's chip, so it is not repeated here.
    const changedSessionFields = new Set(listWorkflowStepSessionChanges(step));
    return (
        <>
            <ItemGroup title={t('workflows.page.sections.groupWho')}>
                <SectionContentRow testID={`${testIDPrefix}-session-chips`}>
                    <SessionAuthoringControls
                        presentation="selects"
                        fields={WORKFLOW_SESSION_FIELD_IDS_BESIDE_ENGINE}
                        values={effectiveExecution}
                        overriddenFields={changedSessionFields}
                        engineChipBeside
                        overriddenAccessibilityHint={t('workflows.page.changedForStep')}
                        resetOverride={{ label: t('workflows.page.useWorkflowsValue'),
                            onResetField: (field) => onChange(setWorkflowStepExecutionField(draft, step.id, field, undefined)) }}
                        onChangeField={(field, value) => onChange(setWorkflowStepExecutionField(draft, step.id, field, value))}
                        renderFieldRow={(field, title, control) => renderWorkflowCardFieldRow(field, title, control)}
                        {...(props.authoringFacts === undefined ? {} : { facts: props.authoringFacts })}
                        testIDPrefix={`${testIDPrefix}-control`}
                    />
                </SectionContentRow>
            </ItemGroup>

            <ItemGroup title={t('workflows.page.sections.whereTitle')}>
                <SegmentedChoiceItem<WorkflowLeafExecutionTargetV1['kind']>
                    testIDPrefix={`${testIDPrefix}-runs-in`}
                    title={t('workflows.page.inspector.runsIn')}
                    {...(ownTarget === undefined && sessionBound ? { subtitle: t('workflows.page.inspector.runsInBoundBySession') } : {})}
                    titleMeta={<WorkflowFieldInheritance fieldId={`${testIDPrefix}-runs-in`}
                        inheritance={ownTarget === undefined ? 'inherited' : 'override'}
                        onReset={() => onChange(setWorkflowStepExecutionTarget(draft, step.id, undefined))} />}
                    valueSource={ownTarget === undefined ? 'inherited' : 'set'}
                    value={ownTarget ?? workflowTarget}
                    // Choosing a value pins it, even one equal to the workflow's (F24); "Use workflow's" clears it.
                    onChange={(next) => onChange(setWorkflowStepExecutionTarget(draft, step.id, next))}
                    accessoryLayout="stacked"
                    options={[
                        { id: 'session', label: runsInLabel('session') },
                        {
                            id: 'detached_run',
                            label: runsInLabel('detached_run'),
                            // An unavailable class stays visible with its reason; never downgraded.
                            ...(detachedUnavailable === undefined || detachedUnavailable.available
                                ? {}
                                : { unavailableReason: t(`workflows.page.unavailable.${detachedUnavailable.unavailableReason}`) }),
                        },
                    ]}
                />
                {/* Workspace is the sessions' checkout picker at step scope (round 1116b change a), on the label track. */}
                <SectionContentRow testID={`${testIDPrefix}-workspace-row`}>
                    {renderWorkflowCardFieldRow('workspace', t('workflows.workspace.title'), (
                        <WorkflowStepWorkspaceField
                            target={props.place?.target}
                            machineName={props.place?.machineName ?? null}
                            {...(props.place?.machines === undefined ? {} : { machines: props.place.machines })}
                            {...(props.place?.accountLifetime === undefined ? {} : { accountLifetime: props.place.accountLifetime })}
                            workspace={workspace}
                            testIDPrefix={`${testIDPrefix}-workspace`}
                        />
                    ))}
                </SectionContentRow>
                {/* The controls are page rows with their own inset: a content row around them indents a second grid. */}
                <View testID={`${testIDPrefix}-continuity-row`}>
                    <WorkflowContinuityControls
                        draft={draft}
                        consumerBlockId={step.id}
                        conversation={step.execution?.conversation}
                        workspace={step.execution?.workspace}
                        inherited={{ conversation: draft.defaults.conversation, workspace: draft.defaults.workspace }}
                        {...(props.existingSessions === undefined ? {} : { existingSessions: props.existingSessions })}
                        onSessionOptionsDemandChange={props.onSessionOptionsDemandChange}
                        sessionOptionsStatus={props.sessionOptionsStatus}
                        onRetrySessionOptions={props.onRetrySessionOptions}
                        onChangeConversation={(value) => onChange(setWorkflowStepExecutionField(draft, step.id, 'conversation', value))}
                        {...(props.bindExistingSession === undefined ? {} : {
                            onBindExistingSession: (sessionId: string) => props.bindExistingSession!(step.id, sessionId),
                        })}
                        testIDPrefix={`${testIDPrefix}-continuity`}
                    />
                </View>
            </ItemGroup>

            <WhenItRunsGroup draft={draft} block={step} onChange={onChange}
                onOpenCondition={() => props.onOpenPage('condition')} testIDPrefix={testIDPrefix} />

            <ItemGroup title={t('workflows.page.sections.thisStepTitle')}>
                <Item
                    testID={`${testIDPrefix}-review`}
                    title={t('workflows.page.inspector.reviewTitle')}
                    subtitle={insideEvaluator
                        ? `${t('workflows.page.inspector.reviewDescription')} ${t('workflows.page.inspector.reviewEvaluator')}`
                        : t('workflows.page.inspector.reviewDescription')}
                    // The consequence is the decision here; it reads whole, never clipped (lab E1o).
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={(
                        <Switch
                            testID={`${testIDPrefix}-review-switch`}
                            accessibilityLabel={t('workflows.page.inspector.reviewTitle')}
                            value={step.pauseForReview === true}
                            onValueChange={(on) => onChange(setWorkflowLeafPauseForReview(draft, step.id, on))}
                        />
                    )}
                />
                <SectionContentRow testID={`${testIDPrefix}-timeout-row`}>
                    <WorkflowStepTimeoutField
                        timeoutMs={step.timeoutMs}
                        onChange={(timeoutMs) => onChange(setWorkflowStepTimeout(draft, step.id, timeoutMs))}
                        testIDPrefix={testIDPrefix}
                    />
                </SectionContentRow>
                <Item
                    testID={`${testIDPrefix}-result`}
                    title={t('workflows.page.inspector.resultTitle')}
                    subtitle={formatWorkflowResultSummary(step.result)}
                    onPress={() => props.onOpenPage('result')}
                />
                {/* Adding an input lives with Result (named results), not on the step's footer, so
                    selecting a step never reveals a row (DESIGN-7 N27). The new input is edited in
                    the document, where bound inputs read. */}
                <Item
                    testID={`${testIDPrefix}-add-input`}
                    title={t('workflows.inputs.addInput')}
                    showChevron={false}
                    onPress={() => onChange(updateWorkflowBlock(draft, step.id, (current) => (
                        current.kind === 'step' ? { ...current, input: [...current.input, { kind: 'literal', value: '' }] } : current
                    )))}
                />
            </ItemGroup>
        </>
    );
}

/** Whether a step is a Repeat's "until a step says stop" evaluator (its review waits per iteration). */
function isLoopEvaluator(blocks: readonly WorkflowBlock[], stepId: string): boolean {
    for (const block of blocks) {
        if (block.kind === 'loop') {
            if (block.repetition.kind === 'evaluate' && block.repetition.evaluator.id === stepId) return true;
            if (isLoopEvaluator(block.body, stepId)) return true;
        } else if (block.kind === 'parallel') {
            if (block.branches.some((branch) => isLoopEvaluator(branch.blocks, stepId))) return true;
        } else if (block.kind === 'if') {
            if (isLoopEvaluator(block.then, stepId) || isLoopEvaluator(block.otherwise, stepId)) return true;
        }
    }
    return false;
}
