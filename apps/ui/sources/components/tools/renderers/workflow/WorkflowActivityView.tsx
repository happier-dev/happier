import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { formatElapsedDuration } from '@/components/sessions/agentActivity/presentation/formatElapsedDuration';
import { useAgentActivityStalenessResolver } from '@/components/sessions/agentActivity/presentation/useAgentActivityStaleness';
import {
    buildWorkflowActivityRows,
    computeWorkflowRunRollup,
    resolveActiveWorkflowPhasePosition,
} from '@/components/sessions/workState/sessionWorkflowActivityPresentation';
import { useWorkflowRunForToolUseId } from '@/components/sessions/workState/useWorkflowRunDetails';
import { resolveAgentActivityEvidenceAtMs } from '@/sync/domains/session/agentActivity';
import type { WorkflowActivityRowViewModel } from '@/components/sessions/workState/sessionWorkflowActivityTypes';
import { fromWorkflowAgentStatus } from '@happier-dev/protocol';
import type { SessionWorkflowAgentStatusV1, SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';

import type { ToolViewProps } from '../core/_registry';
import { WorkflowAgentActivityRow } from './WorkflowAgentActivityRow';
import { WorkflowPhaseHeader } from './WorkflowPhaseHeader';
import { WorkflowRunHeader } from './WorkflowRunHeader';
import { formatWorkflowRunStatusLabel } from './workflowStatusLabel';

/**
 * UIW4 — records-backed transcript workflow card.
 *
 * Joins to the normalized `activity/workflow_run.v1` system record by THIS tool call's own tool-use
 * id (preferred `workflowToolUseId`, fallback `runId`) — never the headline `primaryRunId`. Detail
 * comes from the durable record (does not require loaded transcript pages); the renderer never parses
 * Claude-native `Workflow {script}`/`task_progress` payloads. When no matching snapshot is loaded
 * yet it renders a minimal shell and upgrades in place when the record arrives. This is a distinct
 * path from message-derived `SubAgentSummarySection` (no double-render).
 */

const INLINE_AGENT_INITIAL_LIMIT = 6;
const INLINE_AGENT_PAGE_SIZE = 12;

function agentStatusPriority(status: SessionWorkflowAgentStatusV1): number {
    switch (status) {
        case 'blocked':
            return 0;
        case 'failed':
            return 1;
        case 'active':
            return 2;
        case 'pending':
            return 3;
        case 'complete':
            return 4;
        default:
            return 5;
    }
}

/** Build the bounded inline body: phase headers preserved, agents prioritized active/blocked/failed first. */
function selectInlineRows(snapshot: SessionWorkflowRunSnapshotV1, agentLimit: number): {
    rows: readonly WorkflowActivityRowViewModel[];
    hiddenCount: number;
} {
    const allRows = buildWorkflowActivityRows(snapshot);

    const agentRows = allRows.filter((row): row is Extract<WorkflowActivityRowViewModel, { kind: 'agent' }> => row.kind === 'agent');
    if (agentRows.length <= agentLimit) {
        return { rows: allRows, hiddenCount: 0 };
    }

    const prioritized = [...agentRows].sort(
        (a, b) => agentStatusPriority(a.agent.status) - agentStatusPriority(b.agent.status),
    );
    const keepIds = new Set(prioritized.slice(0, agentLimit).map((row) => row.rowId));
    const rows: WorkflowActivityRowViewModel[] = [];
    for (const row of allRows) {
        if (row.kind === 'phaseHeader') {
            rows.push(row);
        } else if (keepIds.has(row.rowId)) {
            rows.push(row);
        }
    }
    // Drop phase headers that ended up with no visible agents.
    const compacted: WorkflowActivityRowViewModel[] = [];
    for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (row.kind === 'phaseHeader') {
            const next = rows[i + 1];
            if (!next || next.kind === 'phaseHeader') continue;
        }
        compacted.push(row);
    }
    return { rows: compacted, hiddenCount: agentRows.length - keepIds.size };
}

const EMPTY_INLINE_ROWS = Object.freeze({
    rows: Object.freeze([]) as readonly WorkflowActivityRowViewModel[],
    hiddenCount: 0,
});

function formatFooter(snapshot: SessionWorkflowRunSnapshotV1): string {
    const parts: string[] = [];
    // Detail-absent runs (unified-terminal mode) carry no per-agent rows; claiming "0 agents" reads
    // as an empty shell, so only surface the agent count when there is at least one agent.
    if (snapshot.totalAgents > 0) {
        parts.push(t('tools.workflowActivityView.agentsCount', { count: snapshot.totalAgents }));
    }
    if (typeof snapshot.tokensUsed === 'number' && snapshot.tokensUsed > 0) {
        const tokens = snapshot.tokensUsed >= 1000 ? `${(snapshot.tokensUsed / 1000).toFixed(1)}k` : String(snapshot.tokensUsed);
        parts.push(t('tools.workflowActivityView.tokens', { tokens }));
    }
    if (typeof snapshot.timeUsedSeconds === 'number' && snapshot.timeUsedSeconds > 0) {
        // Through the one elapsed formatter (C9), so the run's own duration reads the same as the
        // agent durations above it instead of being a fourth local spelling of the same idea.
        parts.push(formatElapsedDuration(snapshot.timeUsedSeconds * 1_000));
    }
    return parts.join(' · ');
}

export const WorkflowActivityView = React.memo<ToolViewProps>(({ tool, sessionId, metadata }) => {
    const [visibleAgentLimit, setVisibleAgentLimit] = React.useState(INLINE_AGENT_INITIAL_LIMIT);
    const toolUseId = typeof tool.id === 'string' ? tool.id : null;
    const { detail, agentEvidenceAtMsById } = useWorkflowRunForToolUseId({
        sessionId: sessionId ?? '',
        metadata,
        toolUseId,
    });
    // The third host of the shared agent row, and it carried the same defect the run panel did: an
    // agent that has gone silent kept a turning spinner and a running clock. One clock, one
    // threshold, resolved by the host exactly as the roster and the run panel resolve it.
    const resolveStaleness = useAgentActivityStalenessResolver();
    const loadedSnapshot = detail?.state === 'loaded' ? detail.snapshot : null;
    const loadedRunId = loadedSnapshot?.runId ?? null;

    React.useEffect(() => {
        setVisibleAgentLimit(INLINE_AGENT_INITIAL_LIMIT);
    }, [loadedRunId]);

    // Memoized because the rows it builds are now the rows' PROPS, not primitives copied out of
    // them: rebuilding the view models on every render would hand every memoized row a new object
    // and re-render the whole card on each metadata tick.
    const inlineRows = React.useMemo(
        () => (loadedSnapshot ? selectInlineRows(loadedSnapshot, visibleAgentLimit) : EMPTY_INLINE_ROWS),
        [loadedSnapshot, visibleAgentLimit],
    );

    // Minimal shell while the matching record loads / is unknown / is missing.
    if (!detail || detail.state !== 'loaded') {
        const title = typeof tool.input?.name === 'string' && tool.input.name.trim()
            ? String(tool.input.name)
            : t('tools.workflowActivityView.untitled');
        return (
            <View style={styles.container}>
                <View style={styles.shellHeader}>
                    <Text style={styles.shellTitle} numberOfLines={1}>{title}</Text>
                    <Text style={styles.shellStatus}>
                        {detail?.state === 'missing'
                            ? t('tools.workflowActivityView.unavailable')
                            : t('tools.workflowActivityView.loading')}
                    </Text>
                </View>
            </View>
        );
    }

    const snapshot = detail.snapshot;
    const rollup = computeWorkflowRunRollup(snapshot);
    const phase = resolveActiveWorkflowPhasePosition(snapshot);
    const summaryLine = phase
        ? t('tools.workflowActivityView.phaseSummary', {
            index: phase.index,
            total: phase.total,
            complete: snapshot.completedAgents,
            agents: snapshot.totalAgents,
        })
        : undefined;
    const { rows, hiddenCount } = inlineRows;
    const footer = formatFooter(snapshot);
    const showNoDetail = rows.length === 0 && !footer;

    return (
        <View style={styles.container}>
            <WorkflowRunHeader
                title={snapshot.title}
                status={snapshot.status}
                statusLabel={formatWorkflowRunStatusLabel(snapshot.status, snapshot.statusReason)}
                completedAgents={snapshot.completedAgents}
                totalAgents={snapshot.totalAgents}
                rollup={rollup}
                {...(summaryLine ? { summaryLine } : {})}
            />
            <View style={styles.body}>
                {showNoDetail ? (
                    <Text style={styles.noDetail}>{t('tools.workflowActivityView.noDetail')}</Text>
                ) : (
                    rows.map((row, index) =>
                        row.kind === 'phaseHeader' ? (
                            <WorkflowPhaseHeader key={row.rowId} title={row.title} fallback={row.fallback} rollup={row.rollup} />
                        ) : (
                            <WorkflowAgentActivityRow
                                key={row.rowId}
                                agent={row.agent}
                                staleness={resolveStaleness({
                                    status: fromWorkflowAgentStatus(row.agent.status),
                                    // The same later-of join the run panel uses, from the one owner
                                    // (S-3): the durable record can lag the headline, and a second
                                    // spelling here is how one screen ends up calling an agent
                                    // silent while another shows it working.
                                    updatedAtMs: resolveAgentActivityEvidenceAtMs({
                                        entryId: row.rowId,
                                        recordUpdatedAtMs: row.agent.updatedAtMs ?? null,
                                        evidenceAtMsById: agentEvidenceAtMsById,
                                    }),
                                    endedAtMs: row.agent.endedAtMs ?? null,
                                })}
                                showDivider={index < rows.length - 1}
                                testID={`workflow-card-agent-${row.agent.runId}-${row.agent.agentId}`}
                            />
                        ),
                    )
                )}
            </View>
            {hiddenCount > 0 ? (
                <Pressable
                    onPress={() => setVisibleAgentLimit((current) => Math.min(snapshot.agents.length, current + INLINE_AGENT_PAGE_SIZE))}
                    accessibilityRole="button"
                    accessibilityLabel={t('tools.workflowActivityView.showMore', { count: hiddenCount })}
                    style={styles.showMore}
                    testID={`workflow-card-${snapshot.runId}-show-more`}
                    hitSlop={8}
                >
                    <Text style={styles.showMoreText}>
                        {t('tools.workflowActivityView.showMore', { count: hiddenCount })}
                    </Text>
                </Pressable>
            ) : null}
            {footer ? (
                <Text style={styles.footer} numberOfLines={1}>{footer}</Text>
            ) : null}
        </View>
    );
});
WorkflowActivityView.displayName = 'WorkflowActivityView';

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset,
        gap: 8,
    },
    body: {
        gap: 0,
    },
    noDetail: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    shellHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    shellTitle: {
        flex: 1,
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
    shellStatus: {
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
    footer: {
        fontSize: 11,
        color: theme.colors.text.secondary,
    },
}));
