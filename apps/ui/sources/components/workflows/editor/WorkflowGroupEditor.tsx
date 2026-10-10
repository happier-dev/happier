import * as React from 'react';
import { View } from 'react-native';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { doWorkflowParallelBranchesUseSeparateConversations } from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { resolveWorkflowUnnamedHeading, workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { t } from '@/text';

import { updateWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { WORKFLOW_FAILURE_POLICIES, type WorkflowBlock, type WorkflowFailurePolicy } from '@happier-dev/protocol/workflows/workflowV1';

import type { WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { WorkflowBlockHeading, type WorkflowBlockNameEditor } from './WorkflowBlockHeading';
import { WorkflowContainerBody, WorkflowContainerLane, WorkflowContainerOptionsControl } from './WorkflowContainerBody';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '@/components/workflows/presentation/workflowBlockKindGlyph';
import { WorkflowNumberField } from './WorkflowNumberField';
import { workflowEditorStyles } from './workflowEditorStyles';

type ParallelBlock = Extract<WorkflowBlock, Readonly<{ kind: 'parallel' }>>;

export function failurePolicyLabel(policy: WorkflowFailurePolicy): string {
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

/**
 * The heading's meta after its name: "· 2 lanes · 3 at a time" (lab E1 "Side by side · 3 lanes"); the
 * kind is the heading's mark and the failure policy its trailing select.
 */
function formatWorkflowGroupMeta(block: ParallelBlock): string {
    const parts = [t('workflows.page.inspector.laneCount', { count: block.branches.length })];
    if (block.maxConcurrent !== undefined && Number.isFinite(block.maxConcurrent)) {
        parts.push(t('workflows.page.inspector.atATime', { count: block.maxConcurrent }));
    }
    return parts.join(' · ');
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
 * Side by side in the document (lab `editor-E1`): the heading carries the
 * group's kind mark, "Side by side · 2 lanes" as its meta and the failure
 * policy as its trailing select (pressing it opens the group's options). Each
 * lane hangs from the group's rail, named on the tree line, its own Remove in
 * its `⋯`; Add a lane is in the group's `⋯`.
 *
 * The group is an open structure with a rail, not another rounded card wrapped
 * around rounded step cards. Its lanes are supplied by the caller so the same
 * recursive block list renders every nesting level.
 */
export function WorkflowGroupEditor(props: Readonly<{
    block: ParallelBlock;
    ordinal: number;
    selected?: boolean;
    nameEditor?: WorkflowBlockNameEditor;
    actions: readonly WorkflowBlockAction[];
    /** Registers the block's heading as its focus target (blocks without a prompt). */
    focusRegistration?: (focus: (() => void) | null) => void;
    /** A reader's occurrence selector or state, in the heading line (04 §4.11). */
    headingAccessory?: React.ReactNode;
    onSelect: () => void;
    /** Opens the group's options; absent in a read-only document. */
    onOpenOptions?: (anchorRef: React.RefObject<View | null>) => void;
    onAddBranch?: () => void;
    onRemoveBranch?: (branchId: string) => void;
    /** Names a lane in place; absent in a reading document. */
    onRenameBranch?: (branchId: string, name: string) => void;
    /** Commits a lane rename to history (on blur or Enter). */
    onCommitRename?: () => void;
    renderBranch: (branch: ParallelBlock['branches'][number], index: number) => React.ReactNode;
    testIDPrefix: string;
}>): React.ReactElement {
    const displayName = workflowBlockReferenceLabel(props.block);
    const idPrefix = `${props.testIDPrefix}-parallel-${props.block.id}`;
    const { onAddBranch, onRemoveBranch } = props;
    // Add a lane joins the group's own actions, before the destructive one.
    const actions = onAddBranch === undefined ? props.actions : [
        ...props.actions.filter((action) => action.id !== 'remove'),
        { id: 'addBranch' as const, label: t('workflows.editor.addBranch'), onSelect: onAddBranch },
        ...props.actions.filter((action) => action.id === 'remove'),
    ];

    return (
        <View testID={idPrefix} style={workflowEditorStyles.blockBody}>
            <WorkflowBlockHeading
                nameEditor={props.nameEditor}
                kindMark={<Icon name={WORKFLOW_BLOCK_KIND_GLYPH.parallel} size={ICON_SIZE.sm} />}
                ordinal={props.ordinal}
                selected={props.selected}
                unnamed={resolveWorkflowUnnamedHeading(props.block)}
                {...(props.focusRegistration === undefined ? {} : { focusRegistration: props.focusRegistration })}
                displayName={displayName}
                meta={formatWorkflowGroupMeta(props.block)}
                trailing={<WorkflowContainerOptionsControl
                    label={failurePolicyLabel(props.block.failurePolicy)}
                    optionsLabel={t('workflows.page.inspector.options')}
                    {...(props.onOpenOptions === undefined ? {} : { onOpenOptions: props.onOpenOptions })}
                    testID={`${idPrefix}-summary`}
                />}
                actions={actions}
                accessory={props.headingAccessory}
                onSelect={props.onSelect}
                testID={`${idPrefix}-label`}
                actionsTestID={`${idPrefix}-actions`}
            />
            <WorkflowContainerBody>
                {props.block.branches.map((branch, index) => {
                    const placeholder = t('workflows.page.inspector.lane', { position: index + 1 });
                    const label = branch.name ?? placeholder;
                    const { onRenameBranch } = props;
                    return (
                        <WorkflowContainerLane
                            key={branch.id}
                            label={label}
                            {...(onRenameBranch === undefined ? {} : { nameEditor: {
                                value: branch.name ?? '',
                                placeholder,
                                accessibilityLabel: `${t('common.rename')} · ${label}`,
                                onChangeText: (name: string) => onRenameBranch(branch.id, name),
                                ...(props.onCommitRename === undefined ? {} : { onCommit: props.onCommitRename }),
                            } })}
                            labelTestID={`${idPrefix}-branch-${branch.id}-label`}
                            actionsTestID={`${idPrefix}-branch-${branch.id}-actions`}
                            {...(onRemoveBranch === undefined || props.block.branches.length <= 1 ? {} : {
                                actions: [{ id: 'remove' as const, label: t('workflows.editor.remove'), destructive: true,
                                    onSelect: () => onRemoveBranch(branch.id) }],
                            })}
                        >
                            {props.renderBranch(branch, index)}
                        </WorkflowContainerLane>
                    );
                })}
            </WorkflowContainerBody>
        </View>
    );
}
