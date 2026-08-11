import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { fromWorkflowAgentStatus } from '@happier-dev/protocol';
import type { AgentActivityStalenessResolver } from '@/components/sessions/agentActivity/presentation/useAgentActivityStaleness';
import { WorkflowAgentActivityRow } from '@/components/tools/renderers/workflow/WorkflowAgentActivityRow';
import { WorkflowPhaseHeader } from '@/components/tools/renderers/workflow/WorkflowPhaseHeader';
import { WorkflowRunHeader } from '@/components/tools/renderers/workflow/WorkflowRunHeader';
import { formatWorkflowRunStatusLabel } from '@/components/tools/renderers/workflow/workflowStatusLabel';
import { resolveAgentActivityEvidenceAtMs } from '@/sync/domains/session/agentActivity';
import type {
    AgentActivityStatusV1,
    SessionWorkflowRunHeadlineV1,
    SessionWorkflowRunSnapshotV1,
    SessionWorkflowRunStatusV1,
} from '@happier-dev/protocol';

import {
    buildWorkflowActivityRows,
    computeWorkflowRunRollup,
    resolveActiveWorkflowPhasePosition,
} from './sessionWorkflowActivityPresentation';
import type { WorkflowActivityRowViewModel, WorkflowPhaseRollup } from './sessionWorkflowActivityTypes';

/**
 * One workflow run, expanded in place: header, phases, agent rows.
 *
 * **Existence comes from the unified model; depth comes from the producer.** The caller passes the
 * unified entry's title and status — that is what says this run is here and running — and the
 * durable `activity/workflow_run.v1` snapshot supplies everything the entry model structurally
 * cannot carry: ordered phases, per-phase rollups, per-agent provider metrics, summaries and result
 * previews, and the run's own agent fraction.
 *
 * **The fraction is never summed from the rows below it.** `AgentActivityEntry.parentId` authorises
 * grouping and layout only (N-USAGE), so the counts come from the snapshot when it is loaded and
 * from the run headline before that. With neither, the header renders without a meter rather than
 * claiming `0/0`.
 *
 * Rendering is progressive ("show N more"), keeping the host the single scroll owner: no nested
 * virtualized list, and hundreds of agent rows are never mounted until the reader pages to them.
 */

const INLINE_ROW_INITIAL_COUNT = 24;
const INLINE_ROW_PAGE_SIZE = 24;

const EMPTY_ROLLUP: WorkflowPhaseRollup = Object.freeze({
    total: 0,
    complete: 0,
    failed: 0,
    blocked: 0,
    active: 0,
    pending: 0,
    cancelled: 0,
    unknown: 0,
});

/**
 * The unified status vocabulary back into the run-header vocabulary.
 *
 * Only reached before the snapshot lands, and only to pick a glyph and a word. Exhaustive by
 * construction so a new protocol status is placed deliberately rather than defaulting to `unknown`.
 */
function toRunStatus(status: AgentActivityStatusV1): SessionWorkflowRunStatusV1 {
    switch (status) {
        case 'queued':
        case 'starting':
        case 'running':
        case 'waiting':
            return 'active';
        case 'blocked':
            return 'blocked';
        case 'succeeded':
            return 'complete';
        case 'failed':
        case 'timedOut':
            return 'failed';
        case 'cancelled':
            return 'cancelled';
        case 'unknown':
            return 'unknown';
        default: {
            const exhaustive: never = status;
            return exhaustive;
        }
    }
}

export type SessionWorkflowRunPanelProps = Readonly<{
    runId: string;
    /** From the unified entry — the title this run is known by before any record is fetched. */
    entryTitle: string;
    /** From the unified entry — the one owner of whether this run is running. */
    entryStatus: AgentActivityStatusV1;
    /** Detail only: a pre-load title, fraction and status reason. `null` on the degrade path. */
    runHeadline: SessionWorkflowRunHeadlineV1 | null;
    snapshot: SessionWorkflowRunSnapshotV1 | null;
    detailState: 'loading' | 'loaded' | 'missing';
    defaultExpanded: boolean;
    /**
     * The surface's one silence clock, applied to the agent rows this panel draws.
     *
     * These rows sit OUTSIDE the roster list, so they were the one place in the corridor where an
     * agent could be silent for hours and still show a turning spinner and a running clock. The
     * resolver comes from the surface rather than a subscription here, so every agent row on a
     * screen — listed or inside a panel — reads one instant.
     */
    resolveAgentStaleness?: AgentActivityStalenessResolver;
    /**
     * Freshest evidence per agent-activity entry id, from the unified headline.
     *
     * The durable snapshot is refetched on the run's record revision, which does not advance for a
     * display-only update — so the headline can know an agent moved more recently than the snapshot
     * in hand does. Taking the later of the two keeps a working agent from being called silent.
     */
    agentEvidenceAtMsById?: ReadonlyMap<string, number>;
}>;

export function areSessionWorkflowRunPanelPropsEqual(
    prev: SessionWorkflowRunPanelProps,
    next: SessionWorkflowRunPanelProps,
): boolean {
    return prev.runId === next.runId
        && prev.entryTitle === next.entryTitle
        && prev.entryStatus === next.entryStatus
        && prev.runHeadline === next.runHeadline
        && prev.snapshot === next.snapshot
        && prev.detailState === next.detailState
        && prev.defaultExpanded === next.defaultExpanded
        && prev.resolveAgentStaleness === next.resolveAgentStaleness
        && prev.agentEvidenceAtMsById === next.agentEvidenceAtMsById;
}

export const SessionWorkflowRunPanel = React.memo<SessionWorkflowRunPanelProps>((props) => {
    const [expanded, setExpanded] = React.useState(props.defaultExpanded);
    const [visibleRowCount, setVisibleRowCount] = React.useState(INLINE_ROW_INITIAL_COUNT);

    React.useEffect(() => {
        setVisibleRowCount(INLINE_ROW_INITIAL_COUNT);
    }, [props.runId]);

    const rollup = React.useMemo(
        () => (props.snapshot ? computeWorkflowRunRollup(props.snapshot) : null),
        [props.snapshot],
    );
    const summaryLine = React.useMemo(() => {
        if (!props.snapshot) return undefined;
        const phase = resolveActiveWorkflowPhasePosition(props.snapshot);
        if (!phase) return undefined;
        return t('tools.workflowActivityView.phaseSummary', {
            index: phase.index,
            total: phase.total,
            complete: props.snapshot.completedAgents,
            agents: props.snapshot.totalAgents,
        });
    }, [props.snapshot]);

    const allRows = React.useMemo<readonly WorkflowActivityRowViewModel[]>(
        () => (props.snapshot ? buildWorkflowActivityRows(props.snapshot) : []),
        [props.snapshot],
    );
    const visibleRows = allRows.slice(0, visibleRowCount);
    const hiddenCount = allRows.length - visibleRows.length;

    // Producer-supplied, in strict order of authority: the durable record, then the headline, then
    // nothing at all. Never a sum over the rows beneath (N-USAGE).
    const completedAgents = props.snapshot?.completedAgents ?? props.runHeadline?.completedAgents ?? 0;
    const totalAgents = props.snapshot?.totalAgents ?? props.runHeadline?.totalAgents ?? 0;
    const runStatus = props.snapshot?.status ?? props.runHeadline?.status ?? toRunStatus(props.entryStatus);
    const statusReason = props.snapshot?.statusReason ?? props.runHeadline?.statusReason;

    return (
        <View style={styles.panel} testID={`workflow-run-panel-${props.runId}`}>
            <Pressable
                onPress={() => setExpanded((prev) => !prev)}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                testID={`workflow-run-panel-toggle-${props.runId}`}
                hitSlop={6}
            >
                <WorkflowRunHeader
                    title={props.snapshot?.title ?? props.runHeadline?.title ?? props.entryTitle}
                    status={runStatus}
                    statusLabel={formatWorkflowRunStatusLabel(runStatus, statusReason)}
                    completedAgents={completedAgents}
                    totalAgents={totalAgents}
                    rollup={rollup ?? {
                        ...EMPTY_ROLLUP,
                        total: totalAgents,
                        complete: completedAgents,
                        failed: props.runHeadline?.failedAgents ?? 0,
                        blocked: props.runHeadline?.blockedAgents ?? 0,
                    }}
                    expanded={expanded}
                    {...(summaryLine ? { summaryLine } : {})}
                />
            </Pressable>
            {expanded ? (
                props.detailState === 'loaded' && props.snapshot ? (
                    allRows.length === 0 ? (
                        // A loaded run can legitimately carry no phase/agent detail (e.g. a backgrounded
                        // Workflow whose persisted transcript holds only a terminal task-notification).
                        // Degrade to a graceful line instead of an empty expansion shell.
                        <Text style={styles.skeleton}>{t('tools.workflowActivityView.noDetail')}</Text>
                    ) : (
                        <View style={styles.rows}>
                            {visibleRows.map((row, index) =>
                                row.kind === 'phaseHeader' ? (
                                    <WorkflowPhaseHeader key={row.rowId} title={row.title} fallback={row.fallback} rollup={row.rollup} />
                                ) : (
                                    <WorkflowAgentActivityRow
                                        key={row.rowId}
                                        agent={row.agent}
                                        {...(props.resolveAgentStaleness
                                            ? {
                                                staleness: props.resolveAgentStaleness({
                                                    status: fromWorkflowAgentStatus(row.agent.status),
                                                    updatedAtMs: resolveAgentActivityEvidenceAtMs({
                                                        entryId: row.agent.rowId,
                                                        recordUpdatedAtMs: row.agent.updatedAtMs ?? null,
                                                        evidenceAtMsById: props.agentEvidenceAtMsById,
                                                    }),
                                                    endedAtMs: row.agent.endedAtMs ?? null,
                                                }),
                                            }
                                            : null)}
                                        showDivider={index < visibleRows.length - 1}
                                        testID={`workflow-agent-${row.agent.runId}-${row.agent.agentId}`}
                                    />
                                ),
                            )}
                            {hiddenCount > 0 ? (
                                <Pressable
                                    onPress={() => setVisibleRowCount((current) => Math.min(allRows.length, current + INLINE_ROW_PAGE_SIZE))}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('tools.workflowActivityView.showMore', { count: hiddenCount })}
                                    style={styles.showMore}
                                    testID={`workflow-run-${props.runId}-show-more`}
                                    hitSlop={8}
                                >
                                    <Text style={styles.showMoreText}>
                                        {t('tools.workflowActivityView.showMore', { count: hiddenCount })}
                                    </Text>
                                </Pressable>
                            ) : null}
                        </View>
                    )
                ) : props.detailState === 'missing' ? (
                    <Text style={styles.skeleton}>{t('tools.workflowActivityView.unavailable')}</Text>
                ) : (
                    // U-14: reserve space with fixed-height skeleton rows so the panel does not jump
                    // when the durable record arrives.
                    <View
                        style={styles.skeletonRows}
                        accessibilityLabel={t('tools.workflowActivityView.loading')}
                        testID={`workflow-run-panel-skeleton-${props.runId}`}
                    >
                        <View style={styles.skeletonRow} />
                        <View style={[styles.skeletonRow, styles.skeletonRowShort]} />
                        <View style={styles.skeletonRow} />
                    </View>
                )
            ) : null}
        </View>
    );
}, areSessionWorkflowRunPanelPropsEqual);
SessionWorkflowRunPanel.displayName = 'SessionWorkflowRunPanel';

const styles = StyleSheet.create((theme) => ({
    panel: {
        // Flat, card-less rows (matches the goal surface): the run header + phase headers provide
        // grouping, so we avoid a nested filled card inside the popover surface.
        gap: 6,
        paddingVertical: 4,
    },
    rows: {
        gap: 0,
    },
    skeleton: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    skeletonRows: {
        gap: 8,
        paddingVertical: 4,
    },
    skeletonRow: {
        minHeight: 14,
        borderRadius: 6,
        backgroundColor: theme.colors.surface.base,
    },
    skeletonRowShort: {
        width: '60%',
    },
    showMore: {
        minHeight: 40,
        justifyContent: 'center',
    },
    showMoreText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.link,
    },
}));
