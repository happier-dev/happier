import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import { collectWorkflowBlockIds, createWorkflowBlockId, updateWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import {
    WORKFLOW_EVALUATOR_HISTORY_MODES,
    WORKFLOW_ITEM_EXECUTION_MODES,
    type WorkflowBlock,
    type WorkflowEvaluatorHistoryMode,
    type WorkflowItemExecutionMode,
    type WorkflowMaxIterationsV1,
    type WorkflowRepetition,
} from '@happier-dev/protocol/workflows/workflowV1';

import type { WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { WorkflowBlockHeading } from './WorkflowBlockHeading';
import { formatWorkflowConditionSentence, WorkflowConditionEditor } from './WorkflowConditionEditor';
import { WorkflowContainerSummary } from './WorkflowContainerSummary';
import { WorkflowFailurePolicyControl, WorkflowMaxConcurrentControl } from './WorkflowGroupEditor';
import { WorkflowNumberField } from './WorkflowNumberField';
import { formatWorkflowValueReference, WorkflowReferenceSentence, WorkflowValueReferenceEditor } from './WorkflowStepDataEditor';
import { collectWorkflowConditionValueReferences } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { workflowEditorStyles, workflowPressFeedbackStyle } from './workflowEditorStyles';

type LoopBlock = Extract<WorkflowBlock, Readonly<{ kind: 'loop' }>>;

const MODE_LABEL_KEYS = {
    count: 'workflows.loop.modeCount',
    items: 'workflows.loop.modeItems',
    until: 'workflows.loop.modeUntil',
    evaluate: 'workflows.loop.modeEvaluate',
} as const;
const MODES = ['count', 'items', 'until', 'evaluate'] as const satisfies readonly WorkflowRepetition['kind'][];
const HISTORY_LABEL_KEYS = {
    none: 'workflows.loop.historyNone',
    latest: 'workflows.loop.historyLatest',
    all: 'workflows.loop.historyAll',
} as const;

/** The canonical starting repetition for a mode; switching to the current mode keeps it. */
export function repetitionForMode(
    kind: WorkflowRepetition['kind'],
    current: WorkflowRepetition,
    takenIds: ReadonlySet<string>,
): WorkflowRepetition {
    if (kind === current.kind) return current;
    switch (kind) {
        case 'count':
            return { kind: 'count', count: { kind: 'literal', value: 2 } };
        case 'items':
            // Current writers always emit item execution and failure policy
            // explicitly; only the documented legacy ingress may omit them.
            return {
                kind: 'items',
                items: { kind: 'literal', value: [] },
                execution: 'sequential',
                failurePolicy: 'fail_stop',
            };
        case 'until':
            return {
                kind: 'until',
                maxIterations: 3,
                stopWhen: { kind: 'exists', value: { kind: 'literal', value: true } },
            };
        case 'evaluate':
            return {
                kind: 'evaluate',
                maxIterations: 3,
                history: 'latest',
                evaluator: {
                    kind: 'step',
                    id: createWorkflowBlockId('evaluator', takenIds),
                    document: { text: '', references: [], attachments: [] },
                    input: [],
                    result: { kind: 'decision', decisions: ['continue', 'stop'] },
                },
            };
    }
}

/**
 * The loop read as one sentence on the rail: "Repeat 3 times", "For each item
 * in ← Plan result · 3 at a time", "Repeat until ← … is Yes", "Repeat until a
 * step says stop".
 */
export function formatWorkflowLoopSentence(draft: WorkflowEditorDraft, block: LoopBlock): string {
    const repetition = block.repetition;
    switch (repetition.kind) {
        case 'count': {
            const count = repetition.count;
            return t('workflows.page.inspector.repeatTimes', {
                count: count.kind === 'literal' && typeof count.value === 'number'
                    ? count.value
                    : formatWorkflowValueReference(draft, count),
            });
        }
        case 'items': {
            const parts = [t('workflows.page.inspector.forEachIn', { source: formatWorkflowValueReference(draft, repetition.items) })];
            if (repetition.execution === 'parallel' && repetition.maxConcurrent !== undefined && Number.isFinite(repetition.maxConcurrent)) {
                parts.push(t('workflows.page.inspector.atATime', { count: repetition.maxConcurrent }));
            }
            return parts.join(' · ');
        }
        case 'until':
            return t('workflows.page.inspector.repeatUntil', { condition: formatWorkflowConditionSentence(draft, repetition.stopWhen) });
        case 'evaluate':
            return t('workflows.page.inspector.repeatUntilDecided');
    }
}

/**
 * A Repeat's options (Step options for a container, 04 §5.2): the mode, its
 * mode-specific rows, and the round guard. Every edit goes through the draft
 * owner; nothing here keeps a copy.
 */
export function WorkflowLoopOptions(props: Readonly<{
    draft: WorkflowEditorDraft;
    block: LoopBlock;
    onChange: (next: WorkflowEditorDraft) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { draft, block, onChange } = props;
    const { theme } = useUnistyles();
    const idPrefix = `${props.testIDPrefix}-loop-${block.id}`;
    const repetition = block.repetition;
    const updateRepetition = (next: (current: WorkflowRepetition) => WorkflowRepetition) => onChange(updateWorkflowBlock(
        draft,
        block.id,
        (current) => (current.kind === 'loop' ? { ...current, repetition: next(current.repetition) } : current),
    ));
    const setMaxIterations = (maxIterations: WorkflowMaxIterationsV1) => updateRepetition((current) => (
        current.kind === 'until' || current.kind === 'evaluate' ? { ...current, maxIterations } : current
    ));
    const numberInputNames = draft.inputs.filter((input) => input.valueType === 'number').map((input) => input.name);
    const pressStyle = (state: Parameters<typeof workflowPressFeedbackStyle>[0]) => [
        workflowEditorStyles.actionTarget,
        workflowPressFeedbackStyle(state, theme.colors.border.focus),
    ];

    return (
        <ItemGroup title={t('workflows.loop.modeTitle')}>
            <SegmentedChoiceItem<WorkflowRepetition['kind']>
                title={t('workflows.loop.modeTitle')}
                value={repetition.kind}
                onChange={(kind) => updateRepetition((current) => repetitionForMode(kind, current, collectWorkflowBlockIds(draft)))}
                testIDPrefix={`${idPrefix}-mode`}
                options={MODES.map((kind) => ({ id: kind, label: t(MODE_LABEL_KEYS[kind]) }))}
            />

            {repetition.kind === 'count' ? (
                <SectionContentRow testID={`${idPrefix}-count-row`}>
                    <Text style={workflowEditorStyles.metaText}>{t('workflows.loop.count')}</Text>
                    <WorkflowValueReferenceEditor
                        reference={repetition.count}
                        index={0}
                        draft={draft}
                        stepId={block.id}
                        onChange={(count) => updateRepetition((current) => (current.kind === 'count' ? { ...current, count } : current))}
                        testIDPrefix={`${idPrefix}-count`}
                    />
                </SectionContentRow>
            ) : null}

            {repetition.kind === 'items' ? (
                <>
                    <SectionContentRow testID={`${idPrefix}-items-row`}>
                        <Text style={workflowEditorStyles.metaText}>{t('workflows.loop.items')}</Text>
                        <WorkflowValueReferenceEditor
                            reference={repetition.items}
                            index={0}
                            draft={draft}
                            stepId={block.id}
                            onChange={(items) => updateRepetition((current) => (current.kind === 'items' ? { ...current, items } : current))}
                            testIDPrefix={`${idPrefix}-items-source`}
                        />
                        <Text style={workflowEditorStyles.groupSummary}>{t('workflows.loop.emptyListCompletes')}</Text>
                    </SectionContentRow>
                    <SegmentedChoiceItem<WorkflowItemExecutionMode>
                        title={t('workflows.loop.modeItems')}
                        value={repetition.execution}
                        onChange={(execution) => updateRepetition((current) => {
                            if (current.kind !== 'items') return current;
                            // Concurrency is a parallel-only authored value; switching back to
                            // sequential drops it rather than leaving an inert number behind.
                            const { maxConcurrent, ...rest } = current;
                            return execution === 'parallel'
                                ? { ...rest, execution, ...(maxConcurrent === undefined ? {} : { maxConcurrent }) }
                                : { ...rest, execution };
                        })}
                        testIDPrefix={`${idPrefix}-items`}
                        options={WORKFLOW_ITEM_EXECUTION_MODES.map((execution) => ({
                            id: execution,
                            label: execution === 'sequential' ? t('workflows.loop.sequential') : t('workflows.loop.parallel'),
                        }))}
                    />
                    <WorkflowFailurePolicyControl
                        value={repetition.failurePolicy}
                        onChange={(failurePolicy) => updateRepetition((current) => (
                            current.kind === 'items' ? { ...current, failurePolicy } : current
                        ))}
                        testID={`${idPrefix}-failure-policy`}
                    />
                    {repetition.execution === 'parallel' ? (
                        <SectionContentRow testID={`${idPrefix}-max-concurrent-row`}>
                            <WorkflowMaxConcurrentControl
                                label={t('workflows.loop.maxConcurrentItems')}
                                value={repetition.maxConcurrent}
                                onChange={(maxConcurrent) => updateRepetition((current) => {
                                    if (current.kind !== 'items') return current;
                                    if (maxConcurrent !== undefined) return { ...current, maxConcurrent };
                                    const { maxConcurrent: _dropped, ...rest } = current;
                                    return rest;
                                })}
                                testID={`${idPrefix}-max-concurrent`}
                            />
                        </SectionContentRow>
                    ) : null}
                    <SectionContentRow testID={`${idPrefix}-conversation-row`}>
                        <Text style={workflowEditorStyles.groupSummary}>{t('workflows.page.inspector.itemConversation')}</Text>
                    </SectionContentRow>
                </>
            ) : null}

            {repetition.kind === 'until' || repetition.kind === 'evaluate' ? (
                <SectionContentRow testID={`${idPrefix}-max-iterations-row`}>
                    {typeof repetition.maxIterations === 'number' ? (
                        <View style={workflowEditorStyles.actionFieldRow}>
                            {/* The guard is required: clearing it leaves an unresolved
                                number the validator rejects rather than the previous value. */}
                            <WorkflowNumberField
                                label={t('workflows.loop.maxIterations')}
                                value={repetition.maxIterations}
                                onChange={(next) => setMaxIterations(next ?? Number.NaN)}
                                required
                                testID={`${idPrefix}-max-iterations`}
                            />
                            {numberInputNames.length === 0 ? null : (
                                <View style={workflowEditorStyles.metaRow}>
                                    {numberInputNames.map((name) => (
                                        <HappierPressable
                                            key={name}
                                            testID={`${idPrefix}-max-iterations-input-${name}`}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('workflows.page.blocks.useInput', { name })}
                                            onPress={() => setMaxIterations({ kind: 'input', name })}
                                            style={pressStyle}
                                        >
                                            <Text style={workflowEditorStyles.metaAction}>{t('workflows.page.blocks.useInput', { name })}</Text>
                                        </HappierPressable>
                                    ))}
                                </View>
                            )}
                        </View>
                    ) : (
                        <View testID={`${idPrefix}-max-iterations-from-input`} style={workflowEditorStyles.metaRow}>
                            <Text style={workflowEditorStyles.metaText}>
                                {`${t('workflows.loop.maxIterations')} · ${t('workflows.page.blocks.maxFromInput', { name: repetition.maxIterations.name })}`}
                            </Text>
                            <HappierPressable
                                testID={`${idPrefix}-max-iterations-use-number`}
                                accessibilityRole="button"
                                accessibilityLabel={t('workflows.page.blocks.useNumber')}
                                onPress={() => setMaxIterations(Number.NaN)}
                                style={pressStyle}
                            >
                                <Text style={workflowEditorStyles.metaAction}>{t('workflows.page.blocks.useNumber')}</Text>
                            </HappierPressable>
                        </View>
                    )}
                </SectionContentRow>
            ) : null}

            {repetition.kind === 'until' ? (
                <SectionContentRow testID={`${idPrefix}-stop-condition-row`}>
                    <WorkflowConditionEditor
                        label={t('workflows.condition.stopWhen')}
                        condition={repetition.stopWhen}
                        draft={draft}
                        consumerBlockId={block.id}
                        // Evaluated after each round, inside the body scope.
                        continuation
                        required
                        onChange={(stopWhen) => {
                            if (stopWhen === undefined) return;
                            updateRepetition((current) => (current.kind === 'until' ? { ...current, stopWhen } : current));
                        }}
                        testIDPrefix={`${idPrefix}-stop-condition`}
                    />
                </SectionContentRow>
            ) : null}

            {repetition.kind === 'evaluate' ? (
                <SegmentedChoiceItem<WorkflowEvaluatorHistoryMode>
                    title={t('workflows.loop.historyTitle')}
                    subtitle={t('workflows.loop.historyExplain')}
                    value={repetition.history}
                    onChange={(history) => updateRepetition((current) => (current.kind === 'evaluate' ? { ...current, history } : current))}
                    testIDPrefix={`${idPrefix}-history`}
                    options={WORKFLOW_EVALUATOR_HISTORY_MODES.map((history) => ({ id: history, label: t(HISTORY_LABEL_KEYS[history]) }))}
                />
            ) : null}
        </ItemGroup>
    );
}

/**
 * Repeat in the document: the heading, the loop read as one sentence (pressing
 * it opens the loop's options), the body (supplied by the caller as the same
 * recursive block list) and, for "until a step says stop", the step that
 * decides after each round.
 */
export function WorkflowLoopEditor(props: Readonly<{
    draft: WorkflowEditorDraft;
    block: LoopBlock;
    ordinal: number;
    actions: readonly WorkflowBlockAction[];
    /** A reader's occurrence selector or state, in the heading line (04 §4.11). */
    headingAccessory?: React.ReactNode;
    onSelect: () => void;
    /** Opens the loop's options; absent in a read-only document. */
    onOpenOptions?: (anchorRef: React.RefObject<View | null>) => void;
    renderBody: () => React.ReactNode;
    renderContinuation?: () => React.ReactNode;
    testIDPrefix: string;
}>): React.ReactElement {
    const { block, testIDPrefix } = props;
    const displayName = `${t('workflows.editor.unnamedLoop')} ${props.ordinal}`;
    const idPrefix = `${testIDPrefix}-loop-${block.id}`;

    return (
        <View testID={idPrefix} style={workflowEditorStyles.blockBody}>
            <WorkflowBlockHeading
                ordinal={props.ordinal}
                displayName={displayName}
                actions={props.actions}
                accessory={props.headingAccessory}
                onSelect={props.onSelect}
                testID={`${idPrefix}-label`}
                actionsTestID={`${idPrefix}-actions`}
            />
            <WorkflowContainerSummary
                sentence={formatWorkflowLoopSentence(props.draft, block)}
                sentenceContent={<WorkflowReferenceSentence draft={props.draft} sentence={formatWorkflowLoopSentence(props.draft, block)}
                    references={block.repetition.kind === 'count' ? [block.repetition.count]
                        : block.repetition.kind === 'items' ? [block.repetition.items]
                            : block.repetition.kind === 'until' ? collectWorkflowConditionValueReferences(block.repetition.stopWhen) : []} />}
                {...(props.onOpenOptions === undefined ? {} : { onOpenOptions: props.onOpenOptions })}
                optionsLabel={t('workflows.page.inspector.options')}
                testID={`${idPrefix}-summary`}
            />

            <Text style={workflowEditorStyles.branchLabel}>{t('workflows.editor.loopBody')}</Text>
            {props.renderBody()}

            {block.repetition.kind === 'evaluate' ? (
                <>
                    <Text style={workflowEditorStyles.branchLabel}>{t('workflows.editor.continuation')}</Text>
                    {props.renderContinuation?.()}
                </>
            ) : null}
        </View>
    );
}
