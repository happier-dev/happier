import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

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
import { workflowStepPromptLabel } from '@happier-dev/protocol/workflows';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import {
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
    WorkflowResultContract,
    WorkflowStep,
} from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowCondition } from '@happier-dev/protocol/workflows/workflowReferenceV1';

import type { WorkflowRunAsTargetKind } from '../run/workflowRunAsTargets';
import { findWorkflowActionSpec } from '@/components/workflows/presentation/workflowActionCatalog';
import { formatWorkflowConditionSentence, WorkflowConditionEditor } from './WorkflowConditionEditor';
import { WorkflowContinuityControls } from './WorkflowContinuityControls';
import { WorkflowGroupOptions } from './WorkflowGroupEditor';
import type { WorkflowInspectorProps } from './WorkflowInspector';
import { WorkflowLoopOptions } from './WorkflowLoopEditor';
import { formatWorkflowResultSummary } from './WorkflowStepDataEditor';
import { WorkflowStepInspector, WorkflowStepTimeoutField } from './WorkflowStepInspector';
import { useWorkflowStepFieldControlRenderer } from './workflowStepFieldControls';
import { workflowEditorStyles, workflowPressFeedbackStyle } from './workflowEditorStyles';
import { NO_DISCLOSURE, WorkflowInspectorGroup } from './workflowInspectorGroup';

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
    subjectHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
        paddingHorizontal: theme.margins.lg,
        paddingTop: theme.margins.md,
        paddingBottom: theme.margins.sm,
    },
    subjectTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    subjectLocation: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
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
                workflowPressFeedbackStyle(state, theme.colors.border.focus),
            ]}
        >
            <Text style={workflowEditorStyles.metaAction}>{props.label}</Text>
        </HappierPressable>
    );
}

function blockTitle(block: WorkflowBlock): string {
    return block.kind === 'step' ? (workflowStepPromptLabel(block) ?? block.id) : workflowBlockReferenceLabel(block);
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
    const [page, setPage] = React.useState<OptionsPage>('main');
    const showBack = page !== 'main';

    return (
        <View testID={`${testIDPrefix}-options`}>
            <View style={styles.subjectHeader}>
                {showBack ? (
                    <HeaderAction label={t('workflows.page.inspector.back')} onPress={() => setPage('main')} testID={`${testIDPrefix}-back`} />
                ) : null}
                <Text style={styles.subjectTitle} numberOfLines={1}>{blockTitle(block)}</Text>
                {block.kind === 'step' ? (
                    <Text style={styles.subjectLocation} numberOfLines={1}>
                        {`· ${stepDiffers(block) ? t('workflows.page.inspector.differsFromWorkflow') : t('workflows.page.inspector.followsWorkflow')}`}
                    </Text>
                ) : null}
                {props.presentation === 'popover' && props.onDone !== undefined ? (
                    <HeaderAction label={t('common.done')} onPress={props.onDone} testID={`${testIDPrefix}-done`} trailing />
                ) : null}
            </View>

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
        </View>
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
    const onlyRunWhen = (
        <ItemGroup>
            <OnlyRunWhenRow draft={draft} block={block} onOpen={() => props.onOpenPage('condition')} testIDPrefix={testIDPrefix} />
        </ItemGroup>
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

/** The Result destination: a step's or Wait's result shape, pushed into the same surface. */
function ResultPage(props: WorkflowInspectorProps & Readonly<{ block: WorkflowBlock }>): React.ReactElement | null {
    const { block, draft, onChange, testIDPrefix } = props;
    if (block.kind !== 'step' && block.kind !== 'wait') return null;
    const result: WorkflowResultContract = block.result ?? { kind: 'text' };
    const setResult = (next: WorkflowResultContract) => onChange(updateWorkflowBlock(draft, block.id, (current) => (
        current.kind === 'step' || current.kind === 'wait' ? { ...current, result: next } : current
    )));
    if (result.kind === 'decision') {
        // A decision contract is authored by its loop (the evaluator's continue/stop); it is read here, not changed.
        return (
            <ItemGroup>
                <Item testID={`${testIDPrefix}-result-kind`} title={t('workflows.page.inspector.resultTitle')} subtitle={formatWorkflowResultSummary(result)} showChevron={false} />
            </ItemGroup>
        );
    }
    return (
        <ItemGroup>
            <SegmentedChoiceItem<'text' | 'json'>
                title={t('workflows.page.inspector.resultTitle')}
                value={result.kind}
                onChange={(kind) => {
                    if (kind === result.kind) return;
                    setResult(kind === 'text' ? { kind: 'text' } : { kind: 'json', schema: { type: 'object' } });
                }}
                testIDPrefix={`${testIDPrefix}-result-kind`}
                options={[
                    { id: 'text', label: t('workflows.inputs.typeString'), description: t('workflows.page.blocks.returnsText') },
                    { id: 'json', label: t('workflows.inputs.typeJson'), description: t('workflows.page.inspector.returnsStructured') },
                ]}
            />
        </ItemGroup>
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
                <OnlyRunWhenRow draft={draft} block={step} onOpen={() => props.onOpenPage('condition')} testIDPrefix={testIDPrefix} />
            </ItemGroup>

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
