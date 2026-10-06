import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1, type HappierPressableStyleState } from '@happier-dev/plugin-ui/presentation';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { doWorkflowParallelBranchesUseSeparateConversations } from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { t } from '@/text';

import { updateWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { WORKFLOW_FAILURE_POLICIES, type WorkflowBlock, type WorkflowFailurePolicy } from '@happier-dev/protocol/workflows/workflowV1';

import type { WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { WorkflowBlockHeading } from './WorkflowBlockHeading';
import { WorkflowContainerSummary } from './WorkflowContainerSummary';
import { WorkflowNumberField } from './WorkflowNumberField';
import { workflowEditorStyles } from './workflowEditorStyles';

type ParallelBlock = Extract<WorkflowBlock, Readonly<{ kind: 'parallel' }>>;

function failurePolicyLabel(policy: WorkflowFailurePolicy): string {
    return policy === 'fail_stop' ? t('workflows.failurePolicy.failStop') : t('workflows.failurePolicy.collectOutcomes');
}

/**
 * When a step fails: one of two short options, so a value choice whose
 * consequence is the row description (04 §5.2's control table).
 */
export function WorkflowFailurePolicyControl(props: Readonly<{
    value: WorkflowFailurePolicy;
    onChange: (value: WorkflowFailurePolicy) => void;
    testID: string;
}>): React.ReactElement {
    return (
        <SegmentedChoiceItem<WorkflowFailurePolicy>
            title={t('workflows.failurePolicy.title')}
            value={props.value}
            onChange={props.onChange}
            testIDPrefix={props.testID}
            options={WORKFLOW_FAILURE_POLICIES.map((policy) => ({
                id: policy,
                label: failurePolicyLabel(policy),
                description: policy === 'fail_stop'
                    ? t('workflows.failurePolicy.failStopExplain')
                    : t('workflows.failurePolicy.collectOutcomesExplain'),
            }))}
        />
    );
}

/**
 * Optional authored concurrency. An empty field is not zero and not a machine
 * policy: it displays **No workflow limit**, which is the precise meaning of an
 * omitted authored value. Text that is not a whole number stays visible as the
 * unresolved value the canonical validator rejects; it is never read as a
 * limit of 1 or as no limit.
 */
export function WorkflowMaxConcurrentControl(props: Readonly<{
    label: string;
    value: number | undefined;
    onChange: (value: number | undefined) => void;
    testID: string;
}>): React.ReactElement {
    return (
        <WorkflowNumberField
            label={props.label}
            value={props.value}
            onChange={props.onChange}
            placeholder={t('workflows.loop.noWorkflowLimit')}
            testID={props.testID}
        />
    );
}

/** "Side by side · 2 lanes · Stop this group on failure · 3 at a time". */
export function formatWorkflowGroupSentence(block: ParallelBlock): string {
    const parts = [
        t('workflows.page.inspector.lanes', { count: block.branches.length }),
        failurePolicyLabel(block.failurePolicy),
    ];
    if (block.maxConcurrent !== undefined && Number.isFinite(block.maxConcurrent)) {
        parts.push(t('workflows.page.inspector.atATime', { count: block.maxConcurrent }));
    }
    return parts.join(' · ');
}

/**
 * A Side by side group's options (Step options for a container, 04 §5.2):
 * when a step fails, how many lanes at once, and which conversation the lanes
 * reach. Edits go through the draft owner; nothing here keeps a copy.
 */
export function WorkflowGroupOptions(props: Readonly<{
    draft: WorkflowEditorDraft;
    block: ParallelBlock;
    onChange: (next: WorkflowEditorDraft) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { draft, block, onChange } = props;
    const idPrefix = `${props.testIDPrefix}-parallel-${block.id}`;
    const update = (next: (current: ParallelBlock) => ParallelBlock) => onChange(updateWorkflowBlock(
        draft,
        block.id,
        (current) => (current.kind === 'parallel' ? next(current) : current),
    ));
    // True only when every step in the group actually runs a fresh
    // conversation; under the shared default the lanes reach one conversation
    // and take turns, so the group must not claim otherwise.
    const separate = doWorkflowParallelBranchesUseSeparateConversations(draft, block);

    return (
        <ItemGroup title={t('workflows.page.inspector.options')}>
            <WorkflowFailurePolicyControl
                value={block.failurePolicy}
                onChange={(failurePolicy) => update((current) => ({ ...current, failurePolicy }))}
                testID={`${idPrefix}-failure-policy`}
            />
            <SectionContentRow testID={`${idPrefix}-max-concurrent-row`}>
                <WorkflowMaxConcurrentControl
                    label={t('workflows.loop.maxConcurrentBranches')}
                    value={block.maxConcurrent}
                    onChange={(maxConcurrent) => update((current) => {
                        if (maxConcurrent !== undefined) return { ...current, maxConcurrent };
                        const { maxConcurrent: _dropped, ...rest } = current;
                        return rest;
                    })}
                    testID={`${idPrefix}-max-concurrent`}
                />
            </SectionContentRow>
            <SectionContentRow testID={`${idPrefix}-conversation-row`}>
                {separate ? (
                    <Text testID={`${idPrefix}-separate-conversations`} style={workflowEditorStyles.groupSummary}>
                        {t('workflows.conversation.branchesUseSeparate')}
                    </Text>
                ) : (
                    <Text testID={`${idPrefix}-shared-conversation`} style={workflowEditorStyles.groupSummary}>
                        {t('workflows.conversation.branchesShareAndTakeTurns')}
                    </Text>
                )}
            </SectionContentRow>
        </ItemGroup>
    );
}

/**
 * Side by side in the document: the heading, the group read as one sentence
 * (pressing it opens the group's options), then one labelled lane per branch.
 *
 * The group is an open structure with a rail and indentation, not another
 * rounded card wrapped around rounded step cards. Its lanes are supplied by
 * the caller so the same recursive block list renders every nesting level.
 */
export function WorkflowGroupEditor(props: Readonly<{
    block: ParallelBlock;
    ordinal: number;
    actions: readonly WorkflowBlockAction[];
    /** A reader's occurrence selector or state, in the heading line (04 §4.11). */
    headingAccessory?: React.ReactNode;
    onSelect: () => void;
    /** Opens the group's options; absent in a read-only document. */
    onOpenOptions?: (anchorRef: React.RefObject<View | null>) => void;
    onAddBranch?: () => void;
    onRemoveBranch?: (branchId: string) => void;
    renderBranch: (branch: ParallelBlock['branches'][number], index: number) => React.ReactNode;
    testIDPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const displayName = workflowBlockReferenceLabel(props.block);
    const idPrefix = `${props.testIDPrefix}-parallel-${props.block.id}`;
    const pressStyle = (state: HappierPressableStyleState) => [
        workflowEditorStyles.actionTarget,
        state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
    ];

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
                sentence={formatWorkflowGroupSentence(props.block)}
                {...(props.onOpenOptions === undefined ? {} : { onOpenOptions: props.onOpenOptions })}
                optionsLabel={t('workflows.page.inspector.options')}
                testID={`${idPrefix}-summary`}
            />

            {props.block.branches.map((branch, index) => (
                <View key={branch.id} accessibilityRole="none">
                    <View style={workflowEditorStyles.heading}>
                        <Text testID={`${idPrefix}-branch-${branch.id}-label`} style={workflowEditorStyles.headingNameInput}>
                            {`${t('workflows.editor.branch')} ${index + 1}`}
                        </Text>
                        {props.onRemoveBranch !== undefined && props.block.branches.length > 1 ? (
                            <HappierPressable
                                testID={`${idPrefix}-branch-${branch.id}-remove`}
                                accessibilityRole="button"
                                accessibilityLabel={t('workflows.editor.remove')}
                                onPress={() => props.onRemoveBranch?.(branch.id)}
                                style={pressStyle}
                            >
                                <Text style={workflowEditorStyles.issueText}>{t('workflows.editor.remove')}</Text>
                            </HappierPressable>
                        ) : null}
                    </View>
                    {props.renderBranch(branch, index)}
                </View>
            ))}

            {props.onAddBranch === undefined ? null : (
                <HappierPressable
                    testID={`${idPrefix}-add-branch`}
                    accessibilityRole="button"
                    accessibilityLabel={t('workflows.editor.addBranch')}
                    onPress={props.onAddBranch}
                    style={pressStyle}
                >
                    <Text style={workflowEditorStyles.metaAction}>{t('workflows.editor.addBranch')}</Text>
                </HappierPressable>
            )}
        </View>
    );
}
