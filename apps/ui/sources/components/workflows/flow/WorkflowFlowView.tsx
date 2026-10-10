import * as React from 'react';
import { Platform, View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '@/components/workflows/presentation/workflowBlockKindGlyph';
import { formatWorkflowAgentStatusLabel } from '@/components/workflows/presentation/workflowStatusLabel';
import { WorkflowLifecycleStatus } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import {
    describeWorkflowInvocationAttempt,
    describeWorkflowInvocationLifecycle,
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
 * Text-labelled controls take the canonical platform target as a real minimum
 * height. `hitSlop` is inert on react-native-web's `Pressable`, and the desktop
 * app IS the web bundle, so a slop-declared target there is a target that does
 * not exist.
 */
const MINIMUM_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);

const styles = StyleSheet.create((theme) => ({
    actionTarget: {
        borderWidth: 1,
        borderColor: 'transparent',
        minHeight: MINIMUM_TARGET_SIZE,
        justifyContent: 'center',
    },
    meta: {
        ...Typography.default('regular'),
        color: theme.colors.text.tertiary,
        marginLeft: 'auto',
    },
    trailingStatus: {
        marginLeft: 'auto',
    },
    occurrenceList: {
        gap: theme.margins.xs,
        marginLeft: theme.margins.lg,
    },
    occurrenceRow: {
        borderWidth: 1,
        borderColor: 'transparent',
        minHeight: MINIMUM_TARGET_SIZE,
        justifyContent: 'center',
        paddingHorizontal: theme.margins.sm,
        borderRadius: theme.borderRadius.md,
    },
    occurrenceSelected: {
        backgroundColor: theme.colors.surface.selected,
    },
    /** The same pressed-overlay role the map's node rows use. */
    occurrencePressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    occurrenceMeta: {
        ...Typography.default('regular'),
        color: theme.colors.text.tertiary,
    },
    incomplete: {
        ...Typography.default('regular'),
        color: theme.colors.text.tertiary,
    },
    editAction: {
        ...Typography.default('semiBold'),
        color: theme.colors.button.secondary.tint,
    },
    /** The node's one quiet line: what it returns, or that it is the final output. */
    subtitle: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    /** The step's ordinal rides the mark's corner, as the editor numbers the same block. */
    ordinal: {
        position: 'absolute',
        left: -theme.margins.xs,
        top: -theme.margins.xs,
        minWidth: theme.margins.lg,
        paddingHorizontal: theme.margins.xs,
        borderRadius: theme.borderRadius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        alignItems: 'center',
    },
    ordinalText: {
        ...Typography.pillLabel(),
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
            : describeWorkflowInvocationLifecycle(runState.lifecycle, { blockKind: node.kind }).label;
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
                const glyph = FLOW_KIND_GLYPH[node.kind];
                return (
                    <>
                        {glyph !== undefined
                            ? <Icon name={glyph} size={compact ? ICON_SIZE.xs : ICON_SIZE.sm} color={theme.colors.text.secondary} />
                            : props.agentMarkForNode?.(node) ?? <ExecutionRunAgentMark agentId={null} size={compact ? 22 : 28} />}
                        {quiet || node.observed || node.stepOrdinal === undefined ? null : (
                            <View testID={`${testIDPrefix}-node-${node.nodeId}-ordinal`} style={styles.ordinal}>
                                <Text style={styles.ordinalText}>{node.stepOrdinal}</Text>
                            </View>
                        )}
                    </>
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
                    facts: { lifecycle: runState.lifecycle, word: describeWorkflowInvocationLifecycle(runState.lifecycle, { blockKind: node.kind }).label },
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
                return (
                    <>
                        {!quiet && node.maxConcurrent === undefined && (node.kind === 'parallel' || node.repetition?.kind === 'items') ? (
                            <Text testID={`${testIDPrefix}-node-${node.nodeId}-no-limit`} style={styles.meta}>
                                {t('workflows.loop.noWorkflowLimit')}
                            </Text>
                        ) : null}
                        {runState === undefined || runState.occurrenceLabel === undefined ? null : (
                            <Text style={styles.meta}>{runState.occurrenceLabel}</Text>
                        )}
                        {runState !== undefined ? (
                            <View style={styles.trailingStatus}>
                                {/* Healthy finished work is quiet: its mark alone; the node's name says the word. */}
                                <WorkflowLifecycleStatus
                                    testID={`${testIDPrefix}-node-${node.nodeId}-state`}
                                    lifecycle={runState.lifecycle}
                                    blockKind={node.kind}
                                    chrome="plain"
                                    markerOnly={runState.lifecycle === 'completed'}
                                />
                            </View>
                        ) : stateLabel === null ? null : (
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
                return (
                    <View
                        testID={`${testIDPrefix}-node-${node.nodeId}-occurrences`}
                        accessibilityRole="list"
                        accessibilityLabel={node.label}
                        style={styles.occurrenceList}
                    >
                        {occurrences.map((occurrence) => {
                            const occurrenceSelected = occurrence.invocationId === props.selectedInvocationId;
                            const occurrenceState = describeWorkflowInvocationLifecycle(occurrence.lifecycle, { blockKind: node.kind }).label;
                            const attemptLabel = describeWorkflowInvocationAttempt(occurrence.attempt ?? '0').label;
                            const label = occurrence.occurrenceLabel === undefined
                                ? `${attemptLabel} \u00b7 ${occurrenceState}`
                                : `${occurrence.occurrenceLabel} \u00b7 ${attemptLabel} \u00b7 ${occurrenceState}`;
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
                                        <Text style={styles.occurrenceMeta}>{label}</Text>
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
