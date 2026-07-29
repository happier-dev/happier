import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import {
    buildWorkflowActivityRows,
    computeWorkflowRunRollup,
    resolveActiveWorkflowPhasePosition,
    resolveWorkflowRunTone,
} from '@/components/sessions/workState/sessionWorkflowActivityPresentation';
import { useWorkflowRunForToolUseId } from '@/components/sessions/workState/useSessionWorkflowActivity';
import type { WorkflowActivityRowViewModel } from '@/components/sessions/workState/sessionWorkflowActivityTypes';
import type { SessionWorkflowAgentStatusV1, SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';
import { useTranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';

import type { ToolViewProps } from '../core/_registry';
import { WorkflowAgentRow } from './WorkflowAgentRow';
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

function formatFooter(snapshot: SessionWorkflowRunSnapshotV1): string {
    const parts: string[] = [];
    // Detail-absent runs (unified-terminal mode) carry no per-agent rows; claiming "0 agents" reads
    // as an empty shell, so only surface the agent count when there is at least one agent.
    if (snapshot.totalAgents > 0) {
        parts.push(t('tools.workflowActivityView.agentsCount', { count: snapshot.totalAgents }));
    }
    if (typeof snapshot.tokensUsed === 'number' && snapshot.tokensUsed > 0) {
        const tokens = formatTokenCount(snapshot.tokensUsed);
        parts.push(t('tools.workflowActivityView.tokens', { tokens }));
    }
    if (typeof snapshot.timeUsedSeconds === 'number' && snapshot.timeUsedSeconds > 0) {
        const s = snapshot.timeUsedSeconds;
        parts.push(s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);
    }
    return parts.join(' · ');
}

export const WorkflowActivityView = React.memo<ToolViewProps>(({ tool, sessionId, metadata }) => {
    const [visibleAgentLimit, setVisibleAgentLimit] = React.useState(INLINE_AGENT_INITIAL_LIMIT);
    const toolUseId = typeof tool.id === 'string' ? tool.id : null;
    const rowLayoutMutation = useTranscriptRowLayoutMutation();
    const rowLayoutMutationSourceId = `workflow-activity:${toolUseId ?? 'unknown'}`;
    const { detail: sourceDetail } = useWorkflowRunForToolUseId({
        sessionId: sessionId ?? '',
        metadata,
        toolUseId,
    });
    // The records hook updates outside this component. Buffer its next value through a
    // layout effect so the transcript owner can arm the visible-anchor hold before the
    // state commit that replaces a compact shell/body with records-backed content.
    const [detail, setDetail] = React.useState(sourceDetail);
    React.useLayoutEffect(() => {
        if (sourceDetail === detail) return;
        rowLayoutMutation({
            reason: 'content-change',
            sourceId: rowLayoutMutationSourceId,
        });
        setDetail(sourceDetail);
    }, [detail, rowLayoutMutation, rowLayoutMutationSourceId, sourceDetail]);
    const loadedRunId = detail?.state === 'loaded' ? detail.snapshot.runId : null;

    React.useEffect(() => {
        setVisibleAgentLimit(INLINE_AGENT_INITIAL_LIMIT);
    }, [loadedRunId]);

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
    const { rows, hiddenCount } = selectInlineRows(snapshot, visibleAgentLimit);
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
                tone={resolveWorkflowRunTone(snapshot.status)}
                {...(summaryLine ? { summaryLine } : {})}
            />
            <View style={styles.body}>
                {showNoDetail ? (
                    <Text style={styles.noDetail}>{t('tools.workflowActivityView.noDetail')}</Text>
                ) : (
                    rows.map((row) =>
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
                                testID={`workflow-card-agent-${row.agent.runId}-${row.agent.agentId}`}
                            />
                        ),
                    )
                )}
            </View>
            {hiddenCount > 0 ? (
                <Pressable
                    onPress={() => {
                        rowLayoutMutation({
                            reason: 'content-change',
                            sourceId: rowLayoutMutationSourceId,
                        });
                        setVisibleAgentLimit((current) => Math.min(snapshot.agents.length, current + INLINE_AGENT_PAGE_SIZE));
                    }}
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
