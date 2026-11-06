import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { ScrollView, StyleSheet as RNStyleSheet, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import {
    readSessionAuthoringAgentTargetValue,
    retireUnavailableSessionAuthoringRuntimeDescriptor,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
    listWorkflowStepOverriddenFields,
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
import type { WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';
import type { WorkflowCondition } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { SESSION_AUTHORING_CONTROL_FIELD_IDS } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
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
import { WorkflowStepInspector, WorkflowStepTimeoutField } from './WorkflowStepInspector';
import { useWorkflowStepFieldControlRenderer } from './workflowStepFieldControls';
import { workflowEditorStyles } from './workflowEditorStyles';
import { NO_DISCLOSURE, WorkflowInspectorGroup } from './workflowInspectorGroup';
import { WorkflowRunWhenOption } from './WorkflowRunWhenConnector';
import {
    readWorkflowNotifyReportOffer,
    setWorkflowNotifyReportOffer,
    WORKFLOW_NOTIFY_ME_ACTION_ID,
} from './workflowNotifyReportCondition';
import { withWorkflowAuthoringEngine, withWorkflowAuthoringEngineFields } from '@/sync/domains/workflows/workflowAuthoringEngineSelection';

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
type RunsInChoice = 'default' | WorkflowLeafExecutionTargetV1['kind'];

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
        ...Typography.variant('heading'),
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

/** An Agent step differs from the workflow when it sets anything of its own. */
function stepDiffers(step: WorkflowStep): boolean {
    return listWorkflowStepOverriddenFields(step).length > 0
        || step.execution?.conversation !== undefined
        || step.execution?.workspace !== undefined
        || step.execution?.executionTarget !== undefined
        || step.pauseForReview === true;
}

function blockCondition(block: WorkflowBlock): WorkflowCondition | undefined {
    return block.kind === 'if' ? block.when : block.onlyWhen;
}

export function WorkflowBlockOptions(props: WorkflowInspectorProps & Readonly<{ block: WorkflowBlock }>): React.ReactElement {
    const { block, draft, onChange, testIDPrefix } = props;
    const [page, setPageState] = React.useState<OptionsPage>('main');
    const showBack = page !== 'main';
    const [scrolled, setScrolled] = React.useState(false);
    // Each page opens at its top, so the header starts without its divider.
    const setPage = React.useCallback((next: OptionsPage) => { setScrolled(false); setPageState(next); }, []);

    return (
        <View testID={`${testIDPrefix}-options`} style={styles.root}>
            <View style={[styles.subjectHeader, scrolled ? styles.subjectHeaderScrolled : null]}>
                {showBack ? (
                    <HeaderAction label={t('workflows.page.inspector.back')} onPress={() => setPage('main')} testID={`${testIDPrefix}-back`} />
                ) : null}
                {/* A sub-page leads with what it edits; the block it belongs to becomes its location, under the title (lab I1). */}
                <View style={styles.subjectText}>
                    <Text style={styles.subjectTitle} numberOfLines={1}>{subPageTitle(page, block) ?? (block.kind === 'if' ? t('workflows.condition.whenTitle') : blockTitle(block))}</Text>
                    {subPageTitle(page, block) !== null ? (
                        <Text style={styles.subjectLocation} numberOfLines={1}>{blockTitle(block)}</Text>
                    ) : block.kind === 'step' ? (
                        <Text style={styles.subjectLocation} numberOfLines={1}>
                            {stepDiffers(block) ? t('workflows.page.inspector.differsFromWorkflow') : t('workflows.page.inspector.followsWorkflow')}
                        </Text>
                    ) : null}
                </View>
                {props.presentation === 'popover' && props.onDone !== undefined ? (
                    <HeaderAction label={t('common.done')} onPress={props.onDone} testID={`${testIDPrefix}-done`} trailing />
                ) : null}
            </View>

            <ScrollView
                key={page}
                testID={`${testIDPrefix}-options-page`}
                style={styles.page}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                scrollEventThrottle={64}
                onScroll={(event) => setScrolled(event.nativeEvent.contentOffset.y > 0)}
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
            </ScrollView>
        </View>
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
    const renderStepFieldControl = useWorkflowStepFieldControlRenderer({
        ...(props.authoringFacts === undefined ? {} : { facts: props.authoringFacts }),
        testIDPrefix: `${testIDPrefix}-control`,
    });
    const effectiveExecution = resolveEffectiveWorkflowStepExecution(draft, step);
    const continuedSessionLabel = useWorkflowContinuedSessionLabel(effectiveExecution.conversation);
    if (props.documentEditable === false) return <>
        <ItemGroup title={t('workflows.page.sections.conversationTitle')}><SectionContentRow>
            <Text style={workflowEditorStyles.metaText}>{formatWorkflowContinuitySummary({ draft,
                conversation: effectiveExecution.conversation, workspace: effectiveExecution.workspace, existingSessions: props.existingSessions,
                sessionLabel: continuedSessionLabel })}</Text>
        </SectionContentRow></ItemGroup>
        <ItemGroup title={t('workflows.page.sections.agentTitle')}>
            <SessionAuthoringControls presentation="fields" disabled fields={SESSION_AUTHORING_CONTROL_FIELD_IDS}
                values={effectiveExecution} engine={step.execution?.engine ?? draft.defaults.engine} workflowRoles={draft.roles}
                onChangeField={() => {}} onChangeFields={() => {}} onChangeEngine={() => {}}
                facts={props.authoringFacts} testIDPrefix={`${testIDPrefix}-control`} />
        </ItemGroup>
        <ItemGroup>
            <Item title={t('workflows.page.inspector.runsIn')} subtitle={runsInLabel(step.execution?.executionTarget?.kind ?? props.executionTarget ?? 'session')} mode="info" />
            <Item title={t('workflows.page.inspector.reviewTitle')} subtitle={t(step.pauseForReview ? 'common.yes' : 'common.no')} mode="info" />
            <Item title={t('workflows.page.inspector.resultTitle')} subtitle={formatWorkflowResultSummary(step.result)} mode="info" />
            <SectionContentRow><WorkflowConditionEditor editable={false} label={t('workflows.condition.onlyWhen')}
                condition={step.onlyWhen} draft={draft} consumerBlockId={step.id} onChange={() => {}} testIDPrefix={`${testIDPrefix}-condition`} /></SectionContentRow>
            <Item title={t('workflows.editor.timeoutTitle')} subtitle={step.timeoutMs === undefined ? t('workflows.editor.noDeadline')
                : t('workflows.page.inspector.deadline', { ms: step.timeoutMs })} mode="info" />
        </ItemGroup>
    </>;

    // Runs in (U5 precedence): an explicit step choice; else a session-bound
    // conversation decides; else the workflow default.
    const ownTarget = step.execution?.executionTarget?.kind;
    const workflowTarget = props.executionTarget ?? 'session';
    const sessionBound = effectiveExecution.conversation?.kind === 'existing_session'
        || effectiveExecution.conversation?.kind === 'origin_session';
    const runsInValue: RunsInChoice = ownTarget ?? 'default';
    const detachedUnavailable = props.runAsTargets?.find((target) => target.kind === 'detached_run' && !target.available);
    const insideEvaluator = isLoopEvaluator(draft.blocks, step.id);

    return (
        <>
            <ItemGroup title={t('workflows.page.sections.conversationTitle')}>
                <SectionContentRow testID={`${testIDPrefix}-continuity-row`}>
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
                        onChangeWorkspace={(value) => onChange(setWorkflowStepExecutionField(draft, step.id, 'workspace', value))}
                        testIDPrefix={`${testIDPrefix}-continuity`}
                    />
                </SectionContentRow>
            </ItemGroup>

            <ItemGroup title={t('workflows.page.sections.agentTitle')}>
                <SectionContentRow testID={`${testIDPrefix}-agent-row`}>
                    <WorkflowStepInspector
                        draft={draft}
                        step={step}
                        renderFieldControl={renderStepFieldControl}
                        onChangeFields={(fields) => onChange(updateWorkflowBlock(draft, step.id, current => current.kind === 'step'
                            ? { ...current, execution: withWorkflowAuthoringEngineFields(current.execution ?? {}, fields) } : current))}
                        onChangeEngine={(engine) => onChange(updateWorkflowBlock(draft, step.id, current => current.kind === 'step'
                            ? { ...current, execution: withWorkflowAuthoringEngine(current.execution ?? {}, engine) } : current))}
                        onResetEngine={() => onChange(updateWorkflowBlock(draft, step.id, current => {
                            if (current.kind !== 'step') return current;
                            const { engine, agentTarget, modelSelection, acpSessionModeId, sessionConfigOptionOverrides, ...execution } = current.execution ?? {};
                            return { ...current, execution };
                        }))}
                        onResetField={(field) => onChange(setWorkflowStepExecutionField(draft, step.id, field, undefined))}
                        onChangeField={(field, value) => {
                            let next = setWorkflowStepExecutionField(draft, step.id, field, value);
                            if (field === 'agentTarget') {
                                const retired = retireUnavailableSessionAuthoringRuntimeDescriptor({
                                    runtimeDescriptorV1: effectiveExecution.runtimeDescriptorV1,
                                    agentTarget: readSessionAuthoringAgentTargetValue(value),
                                    facts: props.authoringFacts,
                                });
                                if (retired !== effectiveExecution.runtimeDescriptorV1) {
                                    next = setWorkflowStepExecutionField(next, step.id, 'runtimeDescriptorV1', retired);
                                }
                            }
                            onChange(next);
                        }}
                        {...(props.authoringFacts === undefined ? {} : { authoringFacts: props.authoringFacts })}
                        testIDPrefix={testIDPrefix}
                    />
                </SectionContentRow>
            </ItemGroup>

            <ItemGroup>
                <SegmentedChoiceItem<RunsInChoice>
                    testIDPrefix={`${testIDPrefix}-runs-in`}
                    title={t('workflows.page.inspector.runsIn')}
                    {...(ownTarget === undefined && sessionBound ? { subtitle: t('workflows.page.inspector.runsInBoundBySession') } : {})}
                    value={runsInValue}
                    // "Workflow default" deletes the step's own choice; the explicit
                    // option equal to the default still pins it (F24).
                    onChange={(next) => onChange(setWorkflowStepExecutionTarget(draft, step.id, next === 'default' ? undefined : next))}
                    options={[
                        { id: 'default', label: t('workflows.page.inspector.workflowDefault', { value: runsInLabel(workflowTarget) }) },
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
                <Item
                    testID={`${testIDPrefix}-review`}
                    title={t('workflows.page.inspector.reviewTitle')}
                    subtitle={insideEvaluator
                        ? `${t('workflows.page.inspector.reviewDescription')} ${t('workflows.page.inspector.reviewEvaluator')}`
                        : t('workflows.page.inspector.reviewDescription')}
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
            <WhenItRunsGroup draft={draft} block={step} onChange={onChange}
                onOpenCondition={() => props.onOpenPage('condition')} testIDPrefix={testIDPrefix} />

            <AdvancedGroup {...props} block={step} />
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
