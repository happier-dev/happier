import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { WorkflowAgentRow } from '@/components/tools/renderers/workflow/WorkflowAgentRow';
import { WorkflowPhaseHeader } from '@/components/tools/renderers/workflow/WorkflowPhaseHeader';
import { WorkflowRunHeader } from '@/components/tools/renderers/workflow/WorkflowRunHeader';
import { formatWorkflowRunStatusLabel } from '@/components/tools/renderers/workflow/workflowStatusLabel';

import {
    buildWorkflowActivityRows,
    computeWorkflowRunRollup,
    resolveActiveWorkflowPhasePosition,
    resolveWorkflowRunTone,
} from './sessionWorkflowActivityPresentation';
import type { SessionWorkflowActivityState } from './useSessionWorkflowActivity';
import type { SessionWorkflowRunHeadlineV1, SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';
import type { WorkflowActivityRowViewModel } from './sessionWorkflowActivityTypes';

/**
 * UIW3 — Active Workflows popover section.
 *
 * One panel PER active run (keyed by `runId`), in headline active-run order. The `primaryRunId`
 * panel expands by default; secondary active runs start collapsed but show title/status/count
 * rollups so they stay visible. Each expanded panel is phase-primary (ordered phase groups with
 * per-phase rollups and per-agent indicators). Detail comes only from loaded
 * `activity/workflow_run.v1` records; an unloaded run renders a header-only skeleton and upgrades in
 * place. Rows are memoized with primitive props so a progress tick in run A does not re-render run B.
 *
 * Rendering is progressive ("show N more"), keeping the popover the single scroll owner: we never
 * nest a vertical virtualized list inside the popover scroll surface, and we never mount hundreds of
 * agent rows until the user explicitly pages through them. There is no hard cap; every durable
 * record row remains reachable through the same render path.
 */

const INLINE_ROW_INITIAL_COUNT = 24;
const INLINE_ROW_PAGE_SIZE = 24;

export type SessionWorkflowRunPanelProps = Readonly<{
    runHeadline: SessionWorkflowRunHeadlineV1;
    snapshot: SessionWorkflowRunSnapshotV1 | null;
    detailState: 'loading' | 'loaded' | 'missing';
    defaultExpanded: boolean;
}>;

function sameRunHeadline(left: SessionWorkflowRunHeadlineV1, right: SessionWorkflowRunHeadlineV1): boolean {
    return left.runId === right.runId
        && left.title === right.title
        && left.status === right.status
        && left.workflowToolUseId === right.workflowToolUseId
        && left.updatedAt === right.updatedAt
        && left.recordRevision === right.recordRevision
        && left.recordUpdatedAt === right.recordUpdatedAt
        && left.totalAgents === right.totalAgents
        && left.completedAgents === right.completedAgents
        && left.failedAgents === right.failedAgents
        && left.blockedAgents === right.blockedAgents;
}

export function areSessionWorkflowRunPanelPropsEqual(
    prev: SessionWorkflowRunPanelProps,
    next: SessionWorkflowRunPanelProps,
): boolean {
    return prev.snapshot === next.snapshot
        && prev.detailState === next.detailState
        && prev.defaultExpanded === next.defaultExpanded
        && sameRunHeadline(prev.runHeadline, next.runHeadline);
}

const SessionWorkflowRunPanel = React.memo<SessionWorkflowRunPanelProps>((props) => {
    const [expanded, setExpanded] = React.useState(props.defaultExpanded);
    const [visibleRowCount, setVisibleRowCount] = React.useState(INLINE_ROW_INITIAL_COUNT);

    React.useEffect(() => {
        setVisibleRowCount(INLINE_ROW_INITIAL_COUNT);
    }, [props.runHeadline.runId]);

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

    const headerRollup = rollup ?? {
        total: props.runHeadline.totalAgents,
        complete: props.runHeadline.completedAgents,
        failed: props.runHeadline.failedAgents ?? 0,
        blocked: props.runHeadline.blockedAgents ?? 0,
        active: 0,
        pending: 0,
        cancelled: 0,
        unknown: 0,
    };

    return (
        <View style={styles.panel} testID={`workflow-run-panel-${props.runHeadline.runId}`}>
            <Pressable
                onPress={() => setExpanded((prev) => !prev)}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                testID={`workflow-run-panel-toggle-${props.runHeadline.runId}`}
                hitSlop={6}
            >
                <WorkflowRunHeader
                    title={props.snapshot?.title ?? props.runHeadline.title}
                    status={props.runHeadline.status}
                    statusLabel={formatWorkflowRunStatusLabel(props.runHeadline.status, props.runHeadline.statusReason)}
                    completedAgents={props.runHeadline.completedAgents}
                    totalAgents={props.runHeadline.totalAgents}
                    rollup={headerRollup}
                    tone={resolveWorkflowRunTone(props.runHeadline.status)}
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
                            {visibleRows.map((row) =>
                                row.kind === 'phaseHeader' ? (
                                    <WorkflowPhaseHeader key={row.rowId} title={row.title} fallback={row.fallback} rollup={row.rollup} />
                                ) : (
                                    <WorkflowAgentRow
                                        key={row.rowId}
                                        title={row.agent.title}
                                        status={row.agent.status}
                                        {...(row.agent.model ? { model: row.agent.model } : {})}
                                        {...(typeof row.agent.tokensUsed === 'number' ? { tokensUsed: row.agent.tokensUsed } : {})}
                                        {...(typeof row.agent.toolCalls === 'number' ? { toolCalls: row.agent.toolCalls } : {})}
                                        {...(typeof row.agent.timeUsedSeconds === 'number' ? { timeUsedSeconds: row.agent.timeUsedSeconds } : {})}
                                        {...(row.agent.resultPreview ? { resultPreview: row.agent.resultPreview } : {})}
                                        {...(row.agent.summary ? { summary: row.agent.summary } : {})}
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
                                    testID={`workflow-run-${props.runHeadline.runId}-show-more`}
                                    hitSlop={8}
                                >
                                    <Text style={styles.showMoreText}>
                                        {t('tools.workflowActivityView.showMore', { count: hiddenCount })}
                                    </Text>
                                </Pressable>
                            ) : null}
                        </View>
                    )
                ) : (
                    <Text style={styles.skeleton}>
                        {props.detailState === 'missing'
                            ? t('tools.workflowActivityView.unavailable')
                            : t('tools.workflowActivityView.loading')}
                    </Text>
                )
            ) : null}
        </View>
    );
}, areSessionWorkflowRunPanelPropsEqual);
SessionWorkflowRunPanel.displayName = 'SessionWorkflowRunPanel';

export function SessionWorkflowActivitySection(props: Readonly<{
    activity: SessionWorkflowActivityState;
}>): React.ReactElement | null {
    const { headline, activeRuns, runDetailById, loadedRunsById } = props.activity;
    if (activeRuns.length === 0) return null;
    const primaryRunId = headline?.primaryRunId ?? activeRuns[0]?.runId ?? null;

    return (
        <View style={styles.section} testID="session-workflow-activity-section">
            <Text style={styles.sectionTitle}>{t('session.workState.workflow.sectionTitle')}</Text>
            {activeRuns.map((run) => {
                const detail = runDetailById.get(run.runId);
                const detailState = detail?.state === 'loaded'
                    ? 'loaded'
                    : detail?.state === 'missing'
                        ? 'missing'
                        : 'loading';
                return (
                    <SessionWorkflowRunPanel
                        key={run.runId}
                        runHeadline={run}
                        snapshot={loadedRunsById.get(run.runId) ?? null}
                        detailState={detailState}
                        defaultExpanded={run.runId === primaryRunId}
                    />
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    section: {
        gap: 10,
    },
    sectionTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
    },
    panel: {
        gap: 6,
        padding: 10,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset,
    },
    rows: {
        gap: 0,
    },
    skeleton: {
        fontSize: 12,
        color: theme.colors.text.secondary,
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
