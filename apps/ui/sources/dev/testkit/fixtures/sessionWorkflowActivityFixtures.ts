import {
    SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    buildSessionWorkflowActivityHeadline,
    type SessionWorkflowActivityHeadlineV1,
    type SessionWorkflowRunHeadlineV1,
    type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

export function makeSessionWorkflowRunHeadline(
    overrides: Partial<SessionWorkflowRunHeadlineV1> & { runId: string },
): SessionWorkflowRunHeadlineV1 {
    return {
        runId: overrides.runId,
        title: overrides.title ?? `Run ${overrides.runId}`,
        status: overrides.status ?? 'active',
        ...(overrides.statusReason ? { statusReason: overrides.statusReason } : {}),
        updatedAt: overrides.updatedAt ?? 1000,
        recordRevision: overrides.recordRevision ?? '1',
        recordUpdatedAt: overrides.recordUpdatedAt ?? 1000,
        totalAgents: overrides.totalAgents ?? 0,
        completedAgents: overrides.completedAgents ?? 0,
        ...(overrides.workflowToolUseId ? { workflowToolUseId: overrides.workflowToolUseId } : {}),
        ...(typeof overrides.failedAgents === 'number' ? { failedAgents: overrides.failedAgents } : {}),
        ...(typeof overrides.blockedAgents === 'number' ? { blockedAgents: overrides.blockedAgents } : {}),
    };
}

export function makeSessionWorkflowActivityHeadline(
    runs: readonly SessionWorkflowRunHeadlineV1[],
    overrides: Partial<SessionWorkflowActivityHeadlineV1> = {},
): SessionWorkflowActivityHeadlineV1 {
    const headline = buildSessionWorkflowActivityHeadline({
        backendId: overrides.backendId ?? 'claude',
        ...(overrides.agentId ? { agentId: overrides.agentId } : {}),
        updatedAt: overrides.updatedAt ?? 2000,
        runs,
    });
    return {
        ...headline,
        ...(overrides.primaryRunId !== undefined ? { primaryRunId: overrides.primaryRunId } : {}),
        ...(overrides.activeRuns ? { activeRuns: overrides.activeRuns } : {}),
        ...(overrides.recentRuns ? { recentRuns: overrides.recentRuns } : {}),
        ...(overrides.truncated ? { truncated: overrides.truncated } : {}),
    };
}

export function makeSessionWorkflowActivityMetadata(
    runs: readonly SessionWorkflowRunHeadlineV1[],
    overrides: Partial<SessionWorkflowActivityHeadlineV1> = {},
): { sessionWorkflowActivityHeadlineV1: SessionWorkflowActivityHeadlineV1 } {
    return {
        sessionWorkflowActivityHeadlineV1: makeSessionWorkflowActivityHeadline(runs, overrides),
    };
}

export function makeSessionWorkflowRunSnapshot(
    overrides: Partial<SessionWorkflowRunSnapshotV1> = {},
): SessionWorkflowRunSnapshotV1 {
    const runId = overrides.runId ?? 'wf_1';
    return {
        v: 1,
        projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
        runId,
        backendId: overrides.backendId ?? 'claude',
        title: overrides.title ?? `Run ${runId}`,
        status: overrides.status ?? 'active',
        ...(overrides.statusReason ? { statusReason: overrides.statusReason } : {}),
        recordRevision: overrides.recordRevision ?? '1',
        updatedAt: overrides.updatedAt ?? 1000,
        totalAgents: overrides.totalAgents ?? (overrides.agents?.length ?? 0),
        completedAgents: overrides.completedAgents ?? 0,
        phases: overrides.phases ?? [],
        agents: overrides.agents ?? [],
        ...(overrides.agentId ? { agentId: overrides.agentId } : {}),
        ...(overrides.vendorRef ? { vendorRef: overrides.vendorRef } : {}),
        ...(overrides.workflowToolUseId ? { workflowToolUseId: overrides.workflowToolUseId } : {}),
        ...(overrides.sourceSessionId ? { sourceSessionId: overrides.sourceSessionId } : {}),
        ...(overrides.sourceRevision ? { sourceRevision: overrides.sourceRevision } : {}),
        ...(typeof overrides.startedAt === 'number' ? { startedAt: overrides.startedAt } : {}),
        ...(typeof overrides.completedAt === 'number' ? { completedAt: overrides.completedAt } : {}),
        ...(typeof overrides.failedAgents === 'number' ? { failedAgents: overrides.failedAgents } : {}),
        ...(typeof overrides.blockedAgents === 'number' ? { blockedAgents: overrides.blockedAgents } : {}),
        ...(typeof overrides.cancelledAgents === 'number' ? { cancelledAgents: overrides.cancelledAgents } : {}),
        ...(typeof overrides.tokensUsed === 'number' ? { tokensUsed: overrides.tokensUsed } : {}),
        ...(typeof overrides.toolCalls === 'number' ? { toolCalls: overrides.toolCalls } : {}),
        ...(typeof overrides.timeUsedSeconds === 'number' ? { timeUsedSeconds: overrides.timeUsedSeconds } : {}),
    };
}
