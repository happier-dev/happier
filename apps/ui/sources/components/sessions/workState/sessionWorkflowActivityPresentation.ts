import {
    buildAgentActivityEntryId,
    findWorkflowPhaseForAgent,
    SessionWorkflowActivityHeadlineV1Schema,
} from '@happier-dev/protocol';

import type {
    SessionWorkflowActivityHeadlineV1,
    SessionWorkflowAgentStatusV1,
    SessionWorkflowRunHeadlineV1,
    SessionWorkflowRunSnapshotV1,
    SessionWorkflowRunStatusV1,
    WorkflowActivityRowViewModel,
    WorkflowAgentRowViewModel,
    WorkflowPhaseRollup,
    WorkflowPhaseViewModel,
} from './sessionWorkflowActivityTypes';

const UNASSIGNED_PHASE_ID = 'unassigned';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function emptyRollup(): WorkflowPhaseRollup {
    return {
        total: 0,
        complete: 0,
        failed: 0,
        blocked: 0,
        active: 0,
        pending: 0,
        cancelled: 0,
        unknown: 0,
    };
}

function addStatusToRollup(rollup: WorkflowPhaseRollup, status: SessionWorkflowAgentStatusV1): WorkflowPhaseRollup {
    return {
        ...rollup,
        total: rollup.total + 1,
        [status]: rollup[status] + 1,
    };
}

function comparePhases(
    a: SessionWorkflowRunSnapshotV1['phases'][number],
    b: SessionWorkflowRunSnapshotV1['phases'][number],
): number {
    const aOrder = typeof a.order === 'number' ? a.order : Number.POSITIVE_INFINITY;
    const bOrder = typeof b.order === 'number' ? b.order : Number.POSITIVE_INFINITY;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function buildAgentRow(
    snapshot: SessionWorkflowRunSnapshotV1,
    agent: SessionWorkflowRunSnapshotV1['agents'][number],
    phase?: SessionWorkflowRunSnapshotV1['phases'][number],
): WorkflowAgentRowViewModel {
    return {
        // The agent-activity entry id, from the protocol owner — never a template here. The merge in
        // `deriveAgentActivityEntries` unions the published headline with locally derived entries BY
        // ID, so a second spelling of one agent does not fail: it renders that agent twice, with
        // every schema valid and every test green. This row model reaches that merge through the
        // work-state popover, so it is one of the two ends that must agree.
        rowId: buildAgentActivityEntryId({
            kind: 'workflow_agent',
            runId: snapshot.runId,
            agentId: agent.id,
        }),
        runId: snapshot.runId,
        agentId: agent.id,
        title: agent.title,
        status: agent.status,
        ...(phase ? { phaseId: phase.id } : {}),
        ...(phase?.title ? { phaseTitle: phase.title } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(typeof agent.tokensUsed === 'number' ? { tokensUsed: agent.tokensUsed } : {}),
        ...(typeof agent.toolCalls === 'number' ? { toolCalls: agent.toolCalls } : {}),
        ...(typeof agent.timeUsedSeconds === 'number' ? { timeUsedSeconds: agent.timeUsedSeconds } : {}),
        ...(agent.resultPreview ? { resultPreview: agent.resultPreview } : {}),
        ...(agent.summary ? { summary: agent.summary } : {}),
        // Copied only when the snapshot actually has them (D-8): an absent start must stay absent
        // rather than borrow `updatedAt`, and an absent finish must not borrow the start.
        ...(typeof agent.startedAt === 'number' ? { startedAtMs: agent.startedAt } : {}),
        ...(typeof agent.completedAt === 'number' ? { endedAtMs: agent.completedAt } : {}),
        // Evidence, not a start and not a finish: it is the only field the silence rule may read,
        // and it was the one field this projection dropped — which is why run-panel agent rows were
        // structurally incapable of ever going quiet.
        ...(typeof agent.updatedAt === 'number' ? { updatedAtMs: agent.updatedAt } : {}),
    };
}

export function readSessionWorkflowActivityHeadlineFromMetadata(metadata: unknown): SessionWorkflowActivityHeadlineV1 | null {
    if (!isRecord(metadata)) return null;
    const parsed = SessionWorkflowActivityHeadlineV1Schema.safeParse(metadata.sessionWorkflowActivityHeadlineV1);
    return parsed.success ? parsed.data : null;
}

/**
 * Which runs a session has, and in what order, is no longer decided here.
 *
 * `resolveActiveWorkflowRunHeadlines` / `resolvePrimaryWorkflowRunHeadline` /
 * `formatWorkflowAgentFraction` were the read side of the second existence model (r4.1). Existence,
 * status and ordering now come from `sync/domains/session/agentActivity`; this module keeps only
 * the snapshot-shaped presentation the durable record feeds.
 */

export function computeWorkflowPhaseRollup(agents: readonly WorkflowAgentRowViewModel[]): WorkflowPhaseRollup {
    return agents.reduce((rollup, agent) => addStatusToRollup(rollup, agent.status), emptyRollup());
}

export function groupWorkflowAgentsByPhase(snapshot: SessionWorkflowRunSnapshotV1): WorkflowPhaseViewModel[] {
    if (snapshot.phases.length === 0) return [];

    return [...snapshot.phases]
        .sort(comparePhases)
        .map((phase) => {
            const agents = snapshot.agents
                .filter((agent) => findWorkflowPhaseForAgent([phase], agent) !== undefined)
                .map((agent) => buildAgentRow(snapshot, agent, phase));
            return {
                id: phase.id,
                runId: snapshot.runId,
                ...(phase.title ? { title: phase.title } : {}),
                ...(typeof phase.order === 'number' ? { order: phase.order } : {}),
                rollup: computeWorkflowPhaseRollup(agents),
                agents,
            };
        });
}

export function buildWorkflowActivityRows(snapshot: SessionWorkflowRunSnapshotV1): WorkflowActivityRowViewModel[] {
    const phaseGroups = groupWorkflowAgentsByPhase(snapshot);
    if (phaseGroups.length === 0) {
        // The row id is READ off the agent row rather than minted again: one id per agent, one
        // place that decides it. The phased branch below already does this, and the two templates
        // drifting apart is the same failure at a smaller radius.
        return snapshot.agents.map((agent) => {
            const row = buildAgentRow(snapshot, agent);
            return {
                kind: 'agent',
                rowId: row.rowId,
                runId: snapshot.runId,
                agent: row,
            };
        });
    }

    const rows: WorkflowActivityRowViewModel[] = [];
    const phasedAgentIds = new Set<string>();

    for (const phase of phaseGroups) {
        rows.push({
            kind: 'phaseHeader',
            rowId: `${snapshot.runId}:phase:${phase.id}`,
            runId: snapshot.runId,
            phaseId: phase.id,
            ...(phase.title ? { title: phase.title } : {}),
            ...(typeof phase.order === 'number' ? { order: phase.order } : {}),
            rollup: phase.rollup,
        });
        for (const agent of phase.agents) {
            phasedAgentIds.add(agent.agentId);
            rows.push({
                kind: 'agent',
                rowId: agent.rowId,
                runId: snapshot.runId,
                phaseId: phase.id,
                agent,
            });
        }
    }

    const unphasedAgents: WorkflowAgentRowViewModel[] = [];
    for (const agent of snapshot.agents) {
        if (phasedAgentIds.has(agent.id)) continue;
        unphasedAgents.push(buildAgentRow(snapshot, agent));
    }

    if (unphasedAgents.length > 0) {
        rows.push({
            kind: 'phaseHeader',
            rowId: `${snapshot.runId}:phase:${UNASSIGNED_PHASE_ID}`,
            runId: snapshot.runId,
            phaseId: UNASSIGNED_PHASE_ID,
            fallback: 'activity',
            rollup: computeWorkflowPhaseRollup(unphasedAgents),
        });
    }

    for (const row of unphasedAgents) {
        rows.push({
            kind: 'agent',
            rowId: row.rowId,
            runId: snapshot.runId,
            phaseId: UNASSIGNED_PHASE_ID,
            agent: row,
        });
    }

    return rows;
}

/**
 * Progress meter tone for `MeterBar`: success/warning/danger/neutral from a run-level rollup.
 *
 * Not a status->tone owner and not a candidate to be folded into one: its input is an aggregate of
 * agent counts, not a status, and its output is `MeterBar`'s own variant set. A run whose agents
 * are all still working has no status of its own to map — it has a bar to fill.
 */
export function resolveWorkflowMeterTone(rollup: WorkflowPhaseRollup): 'success' | 'warning' | 'danger' | 'neutral' {
    if (rollup.failed > 0) return 'danger';
    if (rollup.blocked > 0) return 'warning';
    if (rollup.total > 0 && rollup.complete === rollup.total) return 'success';
    if (rollup.active > 0) return 'success';
    return 'neutral';
}

/** Completed-over-total fraction in 0..1 for the progress meter; 0 when there are no agents. */
export function resolveWorkflowProgressFraction(run: Pick<SessionWorkflowRunHeadlineV1, 'completedAgents' | 'totalAgents'>): number {
    if (run.totalAgents <= 0) return 0;
    return Math.min(1, Math.max(0, run.completedAgents / run.totalAgents));
}

/** Rollup over all agents in a loaded run snapshot (run-level counts derived from agent rows). */
export function computeWorkflowRunRollup(snapshot: SessionWorkflowRunSnapshotV1): WorkflowPhaseRollup {
    return computeWorkflowPhaseRollup(snapshot.agents.map((agent) => buildAgentRow(snapshot, agent)));
}

/**
 * Resolve the active phase position for a loaded run: the first phase (in order) that still has a
 * non-complete agent. Returns `null` when there are no phases. `index` is 1-based for display.
 */
export function resolveActiveWorkflowPhasePosition(snapshot: SessionWorkflowRunSnapshotV1): Readonly<{
    index: number;
    total: number;
    title?: string;
}> | null {
    const phases = groupWorkflowAgentsByPhase(snapshot);
    if (phases.length === 0) return null;
    const activeIndex = phases.findIndex((phase) => phase.rollup.active > 0 || phase.rollup.blocked > 0 || phase.rollup.pending > 0);
    const resolvedIndex = activeIndex >= 0 ? activeIndex : phases.length - 1;
    const phase = phases[resolvedIndex];
    return {
        index: resolvedIndex + 1,
        total: phases.length,
        ...(phase?.title ? { title: phase.title } : {}),
    };
}
