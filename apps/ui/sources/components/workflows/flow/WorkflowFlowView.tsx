import type { WorkflowInvocationLifecycleV1 } from '@happier-dev/protocol';
import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { Text } from '@/components/ui/text/Text';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '@/components/workflows/presentation/workflowBlockKindGlyph';
import { formatWorkflowAgentStatusLabel } from '@/components/workflows/presentation/workflowStatusLabel';
import { WorkflowLifecycleStatus } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { formatWorkflowInvocationElapsedLabel } from '@/components/workflows/presentation/workflowUsagePresentation';
import {
    describeWorkflowInvocationAttempt,
    describeWorkflowInvocationLifecycle,
    type WorkflowInvocationLifecycleContext,
    workflowLifecycleAwaitsDecision,
} from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { formatHappierWorkMapNodeName, resolveHappierWorkMapNodePosition, type HappierWorkMapDensity, type HappierWorkMapNodePresentation } from '@happier-dev/plugin-ui/presentation';
import { WorkMapView } from '@/components/work/map/WorkMapView';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';

import {
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
 * Text-labelled controls draw at the WCAG 2.2 pointer floor under every pointer; a finger reaches its
 * touch target through the `HappierPressable` hit area past this drawn box.
 */
const MINIMUM_TARGET_SIZE = HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE;

const styles = StyleSheet.create((theme) => ({
    actionTarget: {
        borderWidth: 1,
        borderColor: 'transparent',
        minHeight: MINIMUM_TARGET_SIZE,
        justifyContent: 'center',
    },
    // The map owns where a state sits: trailing on a full-width card, under the name in a narrow lane
    // (lab `run-A` lane cards), so these never push themselves to an edge.
    meta: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
    metaTabular: {
        ...Typography.variant('meta'),
        ...Typography.tabular(),
        color: theme.colors.text.tertiary,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        // A sentence-long state wraps inside the card's status slot rather than overflowing it.
        flexShrink: 1,
        minWidth: 0,
    },
    loopProgress: {
        gap: theme.space.s4,
        minWidth: 0,
    },
    occurrenceList: {
        gap: theme.space.s4,
        marginLeft: theme.space.s16,
    },
    // An item reads as a compact map row: its name leading, its state's mark on the trailing edge in
    // the same status presenter (and tone) the map's cards use, so a held item is amber like its card.
    occurrenceRow: {
        borderWidth: 1,
        borderColor: 'transparent',
        minHeight: MINIMUM_TARGET_SIZE,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s8,
        borderRadius: theme.borderRadius.md,
    },
    occurrenceLabel: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
        minWidth: 0,
    },
    occurrenceState: {
        marginLeft: 'auto',
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    occurrenceSelected: {
        backgroundColor: theme.colors.surface.selected,
    },
    /** The same pressed-overlay role the map's node rows use. */
    occurrencePressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    incomplete: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
    editAction: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.button.secondary.tint,
    },
    /** The node's one quiet line: what it returns, or that it is the final output. */
    subtitle: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    leadingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    /** The step's ordinal numbers the block as the editor does, set before its mark. */
    ordinal: {
        minWidth: theme.space.s16,
        paddingHorizontal: theme.space.s4,
        borderRadius: theme.borderRadius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        alignItems: 'center',
    },
    ordinalText: {
        ...Typography.variant('micro', 'semiBold'),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
}));

/** Leaf kinds that are numbered steps and carry a mark (lab `.wm-g`); containers are headers. */
const FLOW_MARKED_KINDS: ReadonlySet<WorkflowFlowNode['kind']> = new Set(['step', 'action', 'wait', 'workflow', 'evaluator']);

/** A non-agent leaf's kind glyph: the one owner the editor's block headings and Add menu read. */
const FLOW_KIND_GLYPH: Readonly<Partial<Record<WorkflowFlowNode['kind'], IconName>>> = {
    action: WORKFLOW_BLOCK_KIND_GLYPH.action,
    wait: WORKFLOW_BLOCK_KIND_GLYPH.wait,
    workflow: WORKFLOW_BLOCK_KIND_GLYPH.workflow,
};

/**
 * How each workflow construct sits on the map (lab `map-M1`): side-by-side work in lanes under its
 * header, each branch a captioned lane, a loop framed around its body, conditions and observed phases
 * as headers; steps, checks and agents are cards. The grammar stays this producer's; the renderer
 * only draws it.
 */
const FLOW_NODE_LAYOUT: Readonly<Record<WorkflowFlowNode['kind'], HappierWorkMapNodePresentation>> = {
    step: { appearance: 'card' },
    action: { appearance: 'card' },
    wait: { appearance: 'card' },
    workflow: { appearance: 'frame' },
    evaluator: { appearance: 'card' },
    observedAgent: { appearance: 'card' },
    parallel: { appearance: 'group', childLayout: 'lanes' },
    branch: { appearance: 'lane' },
    thenBranch: { appearance: 'lane' },
    otherwiseBranch: { appearance: 'lane' },
    loop: { appearance: 'frame' },
    if: { appearance: 'group' },
    observedPhase: { appearance: 'group' },
};

/** A lane group states only how it ended; while it runs its lanes say what is happening. */
const PARALLEL_SETTLED_LIFECYCLES: ReadonlySet<WorkflowInvocationLifecycleV1> = new Set(['completed', 'failed', 'cancelled', 'outcome_uncertain', 'skipped', 'superseded']);

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
    const compact = props.density === 'compact';
    const quiet = compact || props.preview === true;
    const editTarget = props.onEditStep === undefined || props.selectedNodeId === null
        ? null
        : resolveWorkflowFlowEditTarget(props.projection, props.selectedNodeId);
    const editLabel = editTarget?.kind === 'prompt' ? t('workflows.a11y.editStep') : t('workflows.a11y.editBlock');
    const selectsOccurrence = props.onSelectOccurrence !== undefined;

    const occurrencesOf = (node: WorkflowFlowNode): readonly WorkflowFlowNodeRunState[] =>
        props.runStates?.get(node.nodeId) ?? [];
    const runStateOf = (node: WorkflowFlowNode): WorkflowFlowNodeRunState | undefined => {
        const occurrences = occurrencesOf(node);
        return occurrences.find((state) => state.invocationId === props.selectedInvocationId)
            ?? (occurrences.length === 1 ? occurrences[0] : undefined);
    };
    // Managed lifecycle and observed native activity are different contracts:
    // the managed one goes through the one neutral presenter (icon + label +
    // semantic colour), while observed activity keeps its own label owner and
    // stays plain text.
    const stateLabelOf = (node: WorkflowFlowNode): string | null => {
        const runState = runStateOf(node);
        return runState === undefined
            ? (node.observedStatus === undefined ? null : formatWorkflowAgentStatusLabel(node.observedStatus))
            : describeWorkflowInvocationLifecycle(runState.lifecycle, { ...props.invocationStatusContext, blockKind: node.kind }).label;
    };

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
            accessibilityLabelForNode={(node) => {
                const structure = describeNodeStructure(props.projection, node);
                const stateLabel = stateLabelOf(node);
                return stateLabel === null
                    ? structure
                    : t('workflows.a11y.flowNode', { node: structure, state: stateLabel });
            }}
            // A definition's top-level blocks run one after another; observed activity proves no order.
            rootLayout={props.projection.source === 'definition' ? 'sequence' : 'separate'}
            renderLeading={(node) => {
                if (!FLOW_MARKED_KINDS.has(node.kind)) return null;
                // On a Run the lifecycle owns the Wait's one state mark. Its authored
                // hand belongs in the editor; beside a completion check it contradicts it.
                const glyph = node.kind === 'wait' && props.runStates !== undefined
                    ? undefined : FLOW_KIND_GLYPH[node.kind];
                const ordinal = quiet || node.observed || node.stepOrdinal === undefined ? null : (
                    <View testID={`${testIDPrefix}-node-${node.nodeId}-ordinal`} style={styles.ordinal}>
                        <Text style={styles.ordinalText}>{node.stepOrdinal}</Text>
                    </View>
                );
                // The ordinal is set apart, ahead of the mark, so a logo drawn without a tile is never covered.
                return (
                    <View style={styles.leadingRow}>
                        {ordinal}
                        {glyph !== undefined
                            ? <Icon name={glyph} size={compact ? ICON_SIZE.xs : ICON_SIZE.sm} color={theme.colors.text.secondary} />
                            : node.kind === 'wait' ? null
                                : props.agentMarkForNode?.(node) ?? <ExecutionRunAgentMark agentId={null} size={compact ? 22 : 28} />}
                    </View>
                );
            }}
            renderSubtitle={(node) => {
                if (props.preview === true) return null;
                const line = node.finalOutput === true
                    ? t('workflows.finalOutput.title')
                    : node.returns === undefined ? null : t('workflows.page.blocks.returnsFields', { fields: node.returns.join(' · ') });
                return line === null ? null : <Text style={styles.subtitle} numberOfLines={1}>{line}</Text>;
            }}
            presentNode={(node) => {
                const runState = runStateOf(node);
                const layout = FLOW_NODE_LAYOUT[node.kind];
                if (runState === undefined) return layout;
                // INT I3: the ring and tint come from the shared status tone, never a local colour rule.
                const { tone } = resolveWorkStatusTone({
                    kind: 'workflow_step',
                    facts: { ...props.invocationStatusContext, lifecycle: runState.lifecycle,
                        word: describeWorkflowInvocationLifecycle(runState.lifecycle, { ...props.invocationStatusContext, blockKind: node.kind }).label },
                });
                return { ...layout, tone };
            }}
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
            renderStatus={(node) => {
                const runState = runStateOf(node);
                const stateLabel = stateLabelOf(node);
                const elapsed = formatWorkflowInvocationElapsedLabel(runState?.timing);
                return (
                    <>
                        {/* An authoring fact; a Run's Map shows what is happening, not unset configuration. */}
                        {!quiet && props.runStates === undefined && node.maxConcurrent === undefined
                            && (node.kind === 'parallel' || node.repetition?.kind === 'items') ? (
                            <Text testID={`${testIDPrefix}-node-${node.nodeId}-no-limit`} style={styles.meta}>
                                {t('workflows.loop.noWorkflowLimit')}
                            </Text>
                        ) : null}
                        {runState === undefined || runState.occurrenceLabel === undefined ? null : (
                            <Text style={styles.meta}>{runState.occurrenceLabel}</Text>
                        )}
                        {runState?.loopProgress !== undefined ? (
                            // A repeat-for-each reads as its progress (lab run-A `For each issue`): items done of
                            // all, how many at a time, and the bar; the items themselves carry their own states.
                            <View testID={`${testIDPrefix}-node-${node.nodeId}-loop-progress`} style={styles.loopProgress}>
                                <Text style={styles.metaTabular}>{[
                                    `${runState.loopProgress.completed} / ${runState.loopProgress.total}`,
                                    runState.loopProgress.maxConcurrent === undefined ? null
                                        : t('workflows.page.inspector.atATime', { count: runState.loopProgress.maxConcurrent }),
                                ].filter(Boolean).join(' \u00b7 ')}</Text>
                                <MeterBar tone="neutral" height={4} fillColor={theme.colors.text.secondary}
                                    fillFraction={runState.loopProgress.total === 0 ? 0 : runState.loopProgress.completed / runState.loopProgress.total} />
                            </View>
                        ) : runState !== undefined ? (
                            <View style={styles.statusRow}>
                                {elapsed === null ? null : <Text style={styles.metaTabular}>{elapsed}</Text>}
                                {/* Healthy finished work is quiet: its mark alone; the node's name says the word. Lanes
                                    that are still going speak for themselves, so their group adds no word of its own
                                    (DESIGN-17 R7; lab run-A shows none). */}
                                {node.kind === 'parallel' && !PARALLEL_SETTLED_LIFECYCLES.has(runState.lifecycle) ? null : <WorkflowLifecycleStatus
                                    testID={`${testIDPrefix}-node-${node.nodeId}-state`}
                                    lifecycle={runState.lifecycle}
                                    blockKind={node.kind}
                                    context={props.invocationStatusContext}
                                    chrome="plain"
                                    markerOnly={runState.lifecycle === 'completed' || workflowLifecycleAwaitsDecision(runState.lifecycle)}
                                />}
                            </View>
                        ) : stateLabel === null ? (props.notStartedLabel !== undefined && props.runStates !== undefined && FLOW_MARKED_KINDS.has(node.kind) && !node.observed && occurrencesOf(node).length === 0
                            ? <Text testID={`${testIDPrefix}-node-${node.nodeId}-not-started`} style={styles.meta}>{props.notStartedLabel}</Text> : null) : (
                            <Text testID={`${testIDPrefix}-node-${node.nodeId}-state`} style={styles.meta}>
                                {stateLabel}
                            </Text>
                        )}
                    </>
                );
            }}
            renderDetail={(node) => {
                const occurrences = occurrencesOf(node);
                if (!selectsOccurrence || occurrences.length <= 1) return null;
                const retried = occurrences.some((occurrence) => (occurrence.attempt ?? '0') !== '0');
                return (
                    <View
                        testID={`${testIDPrefix}-node-${node.nodeId}-occurrences`}
                        accessibilityRole="list"
                        accessibilityLabel={node.label}
                        style={styles.occurrenceList}
                    >
                        {occurrences.map((occurrence) => {
                            const occurrenceSelected = occurrence.invocationId === props.selectedInvocationId;
                            const elapsed = formatWorkflowInvocationElapsedLabel(occurrence.timing);
                            const occurrenceState = describeWorkflowInvocationLifecycle(occurrence.lifecycle, { ...props.invocationStatusContext, blockKind: node.kind }).label;
                            // Attempts are named only where a retry exists to tell apart; otherwise the
                            // first attempt is implied and "Attempt 1" on every item is noise.
                            const attempt = occurrence.attempt ?? '0';
                            const name = [occurrence.occurrenceLabel,
                                retried ? describeWorkflowInvocationAttempt(attempt).label : undefined,
                            ].filter(Boolean).join(' \u00b7 ');
                            const label = [name, occurrenceState].filter(Boolean).join(' \u00b7 ');
                            return (
                                <View
                                    key={occurrence.invocationId}
                                    testID={`${testIDPrefix}-node-${node.nodeId}-occurrence-item-${occurrence.invocationId}`}
                                    role="listitem"
                                >
                                    <HappierPressable
                                        testID={`${testIDPrefix}-node-${node.nodeId}-occurrence-${occurrence.invocationId}`}
                                        accessibilityRole="button"
                                        selected={occurrenceSelected}
                                        current={occurrenceSelected ? 'page' : undefined}
                                        accessibilityLabel={t('workflows.a11y.flowNode', { node: node.label, state: label })}
                                        onPress={(event) => props.onSelectOccurrence?.(occurrence.invocationId, event)}
                                        style={({ pressed, focused }) => [
                                            styles.occurrenceRow,
                                            occurrenceSelected ? styles.occurrenceSelected : null,
                                            pressed ? styles.occurrencePressed : null,
                                            focusRingStyle({ focused, color: theme.colors.border.focus }),
                                        ]}
                                    >
                                        <Text style={styles.occurrenceLabel} numberOfLines={1}>{name}</Text>
                                        <View style={styles.occurrenceState}>
                                            {elapsed !== null ? (
                                                <Text style={styles.metaTabular}>{elapsed}</Text>
                                            ) : null}
                                            <WorkflowLifecycleStatus
                                                testID={`${testIDPrefix}-node-${node.nodeId}-occurrence-${occurrence.invocationId}-state`}
                                                lifecycle={occurrence.lifecycle}
                                                blockKind={node.kind}
                                                context={props.invocationStatusContext}
                                                chrome="plain"
                                                // The mark alone: in a lane the state's words would take the
                                                // row from the item's own name (DESIGN-15 R2); the card above
                                                // and the row's label already say it.
                                                markerOnly
                                            />
                                        </View>
                                    </HappierPressable>
                                </View>
                            );
                        })}
                    </View>
                );
            }}
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
