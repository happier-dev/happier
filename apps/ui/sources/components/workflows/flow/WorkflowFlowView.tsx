import * as React from 'react';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
    type WorkflowInvocationLifecycleContext,
} from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { useUnistyles } from 'react-native-unistyles';

import { formatHappierWorkMapNodeName, resolveHappierWorkMapNodePosition, type HappierWorkMapDensity } from '@happier-dev/plugin-ui/presentation';
import { useWorkflowFlowLoopScope } from './useWorkflowFlowLoopScope';
import { useWorkflowFlowNodeSlots, workflowFlowStyles as styles } from './useWorkflowFlowNodeSlots';
import { WorkMapView } from '@/components/work/map/WorkMapView';

import {
    listWorkflowFlowNotTakenNodeIds,
    resolveWorkflowFlowEditTarget,
    type WorkflowFlowEditTarget,
    type WorkflowFlowNode,
    type WorkflowFlowNodeRunState,
    type WorkflowFlowProjection,
} from './workflowFlowProjection';

/**
 * Flow: a derived reading mode, not a second editor and not a canvas.
 *
 * It renders through the one Work map renderer (`WorkMapView`); this file
 * supplies only the workflow words: structure and state announcements, run
 * state, occurrences and the Edit action.
 *
 * Narrow and wide layouts share one vertical outline with the same execution
 * rails, so a phone never has to pan a desktop canvas to read a prompt. The
 * accessible order is the linear DOM order, connectors are decorative and
 * motionless, and every node action has a non-drag equivalent.
 */

/**
 * The structural context a node's accessible name has to carry.
 *
 * Rails are decorative and hidden, so indentation alone communicates nothing
 * to a reader: a nested outline was heard as one flat run of buttons with no
 * way to tell which container a step belonged to or how many siblings it had.
 * Both sentences already exist as localized announcement copy.
 */
function describeNodeStructure(
    projection: WorkflowFlowProjection,
    node: WorkflowFlowNode,
): string {
    const { position, total, parent } = resolveHappierWorkMapNodePosition(projection, node);
    const positioned = t('workflows.a11y.stepContext', { block: formatHappierWorkMapNodeName(node), position, total });
    return parent === null
        ? positioned
        : t('workflows.a11y.groupContext', { group: formatHappierWorkMapNodeName(parent), block: positioned });
}

export function WorkflowFlowView(props: Readonly<{
    invocationStatusContext?: WorkflowInvocationLifecycleContext;
    projection: WorkflowFlowProjection;
    selectedNodeId: string | null;
    onSelectNode?: (nodeId: string) => void;
    /**
     * Present only for an authored definition; observed activity has no
     * editable target. The target is the projection's answer, so a branch
     * frame reveals its owning group rather than an id no editor has.
     */
    onEditStep?: (target: WorkflowFlowEditTarget) => void;
    runStates?: ReadonlyMap<string, readonly WorkflowFlowNodeRunState[]>;
    selectedInvocationId?: string | null;
    /** The press event travels so the caller can return focus to this node later. */
    onSelectOccurrence?: (invocationId: string, event?: Parameters<React.ComponentProps<typeof HappierPressable>['onPress']>[0]) => void;
    testIDPrefix?: string;
    /** `compact`: the live mini-map under a Work row — structure and state only. */
    density?: HappierWorkMapDensity;
    /**
     * A workflow's shape with nothing to run (an example tile, lab `nav-N3`): the map's own type and
     * lane captions, without ordinals, result lines or run facts. Its size is the caller's `density`.
     */
    preview?: boolean;
    /**
     * A live Run's map says what has not begun ("Not started", lab `run-A`): the label for an executable step
     * that has no occurrence yet. Omitted for a settled Run and for authoring/preview maps.
     */
    notStartedLabel?: string;
    /** The Agent mark of a step's accepted selection, when the caller knows it; else a neutral mark. */
    agentMarkForNode?: (node: WorkflowFlowNode) => React.ReactNode | null;
}>): React.ReactElement {
    const testIDPrefix = props.testIDPrefix ?? 'workflow-flow';
    const { theme } = useUnistyles();
    // Slots consume colours, whose identity survives Unistyles' per-render outer Proxy.
    const nodeTheme = React.useMemo(() => ({ colors: theme.colors }), [theme.colors]);
    const compact = props.density === 'compact';
    const editTarget = props.onEditStep === undefined || props.selectedNodeId === null
        ? null
        : resolveWorkflowFlowEditTarget(props.projection, props.selectedNodeId);
    const editLabel = editTarget?.kind === 'prompt' ? t('workflows.a11y.editStep') : t('workflows.a11y.editBlock');
    const selectsOccurrence = props.onSelectOccurrence !== undefined;

    // A Run's loop draws one item at a time; compact and preview maps keep every occurrence.
    const loopScope = useWorkflowFlowLoopScope({
        enabled: selectsOccurrence && !compact && props.preview !== true,
        projection: props.projection,
        runStates: props.runStates,
        selectedInvocationId: props.selectedInvocationId ?? null,
        invocationStatusContext: props.invocationStatusContext,
        onSelectOccurrence: props.onSelectOccurrence,
    });
    const runStates = loopScope.runStates;
    const notTaken = React.useMemo(() => listWorkflowFlowNotTakenNodeIds(props.projection, runStates),
        [props.projection, runStates]);
    const nodeSlots = useWorkflowFlowNodeSlots(props.projection.nodes.map(node => {
        const occurrences = runStates?.get(node.nodeId) ?? [];
        return {
            node,
            structure: describeNodeStructure(props.projection, node),
            occurrences,
            selectedInvocationId: occurrences.some(state => state.invocationId === props.selectedInvocationId)
                ? props.selectedInvocationId ?? null : null,
            invocationStatusContext: props.invocationStatusContext,
            hasRunStates: runStates !== undefined,
            selectsOccurrence,
            onSelectOccurrence: occurrences.length > 1 ? props.onSelectOccurrence : undefined,
            agentMarkForNode: props.agentMarkForNode,
            compact,
            preview: props.preview === true,
            notStartedLabel: props.notStartedLabel,
            notTaken: notTaken.has(node.nodeId),
            loopView: node.kind === 'loop' ? loopScope.loops.get(node.nodeId) : undefined,
            itemNamedBySelector: occurrences.some(state => state.repetitions?.some(repetition =>
                (loopScope.loops.get(repetition.loopNodeId)?.items.length ?? 0) > 1) === true),
            onSelectLoopItem: loopScope.selectItem,
            onFilterLoopItems: loopScope.filterItems,
            testIDPrefix,
            theme: nodeTheme,
        };
    }));
    const occurrencesOf = (node: WorkflowFlowNode) => runStates?.get(node.nodeId) ?? [];

    return (
        <WorkMapView<WorkflowFlowNode>
            map={props.projection}
            selectedNodeId={props.selectedNodeId}
            testIDPrefix={testIDPrefix}
            {...(props.density === undefined ? {} : { density: props.density })}
            header={props.projection.relationships === 'unknown' && !compact ? (
                <Text testID={`${testIDPrefix}-observed-note`} style={styles.incomplete}>
                    {t('workflows.run.observedActivityBody')}
                </Text>
            ) : null}
            accessibilityLabelForNode={(node) => nodeSlots.get(node.nodeId)!.accessibilityLabelForNode}
            // A definition's top-level blocks run one after another; observed activity proves no order.
            rootLayout={props.projection.source === 'definition' ? 'sequence' : 'separate'}
            renderLeading={(node) => nodeSlots.get(node.nodeId)!.renderLeading}
            renderSubtitle={(node) => nodeSlots.get(node.nodeId)!.renderSubtitle}
            presentNode={(node) => nodeSlots.get(node.nodeId)!.presentNode}
            isNodeDisabled={(node) => selectsOccurrence && occurrencesOf(node).length !== 1}
            onOpen={(node, event) => {
                if (selectsOccurrence) {
                    const occurrences = occurrencesOf(node);
                    const onlyOccurrence = occurrences[0];
                    if (occurrences.length === 1 && onlyOccurrence !== undefined) {
                        props.onSelectOccurrence?.(onlyOccurrence.invocationId, event);
                    }
                    return;
                }
                props.onSelectNode?.(node.nodeId);
            }}
            renderStatus={(node) => nodeSlots.get(node.nodeId)!.renderStatus}
            renderDetail={(node) => nodeSlots.get(node.nodeId)!.renderDetail}
            footer={editTarget === null ? null : (
                <HappierPressable
                    testID={`${testIDPrefix}-edit-step`}
                    accessibilityRole="button"
                    accessibilityLabel={editLabel}
                    onPress={() => props.onEditStep?.(editTarget)}
                    style={({ focused, pressed }) => [styles.actionTarget,
                        pressed ? styles.occurrencePressed : null,
                        focusRingStyle({ focused, color: theme.colors.border.focus })]}
                >
                    <Text style={styles.editAction}>{editLabel}</Text>
                </HappierPressable>
            )}
        />
    );
}
