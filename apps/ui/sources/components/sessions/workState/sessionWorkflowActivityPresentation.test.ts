import { describe, expect, it } from 'vitest';

import { buildAgentActivityEntryId, type SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';
import {
    makeSessionWorkflowActivityHeadline,
    makeSessionWorkflowRunHeadline,
    makeSessionWorkflowRunSnapshot,
} from '@/dev/testkit';

import {
    buildWorkflowActivityRows,
    computeWorkflowPhaseRollup,
    computeWorkflowRunRollup,
    groupWorkflowAgentsByPhase,
    readSessionWorkflowActivityHeadlineFromMetadata,
    resolveActiveWorkflowPhasePosition,
    resolveWorkflowMeterTone,
    resolveWorkflowProgressFraction,
} from './sessionWorkflowActivityPresentation';

const headlineRun = makeSessionWorkflowRunHeadline;
const headline = makeSessionWorkflowActivityHeadline;

/**
 * An agent row id, asked of the protocol owner rather than spelled here.
 *
 * These tests are about ORDER and GROUPING, not about how an id reads, and a hand-written wire
 * literal in each of them would make the spelling need a lockstep edit in six places the next time
 * it moves. The spelling itself is locked once, at the owner
 * (`packages/protocol/…/agentActivityEntryId.test.ts`), and the producer/consumer agreement is
 * locked in `sessionWorkflowActivityEntryIdParity.test.ts`.
 */
function agentRowId(agentId: string, runId = 'run1'): string {
    return buildAgentActivityEntryId({ kind: 'workflow_agent', runId, agentId });
}

describe('readSessionWorkflowActivityHeadlineFromMetadata', () => {
    it('reads a valid headline from metadata.sessionWorkflowActivityHeadlineV1', () => {
        const h = headline([headlineRun({ runId: 'a', totalAgents: 3, completedAgents: 1 })]);
        const result = readSessionWorkflowActivityHeadlineFromMetadata({ sessionWorkflowActivityHeadlineV1: h });
        expect(result?.activeRuns).toHaveLength(1);
        expect(result?.activeRuns[0]?.runId).toBe('a');
    });

    it('ignores malformed headline metadata', () => {
        expect(readSessionWorkflowActivityHeadlineFromMetadata({ sessionWorkflowActivityHeadlineV1: { v: 2 } })).toBeNull();
        expect(readSessionWorkflowActivityHeadlineFromMetadata({ sessionWorkflowActivityHeadlineV1: 'nope' })).toBeNull();
        expect(readSessionWorkflowActivityHeadlineFromMetadata(null)).toBeNull();
        expect(readSessionWorkflowActivityHeadlineFromMetadata({})).toBeNull();
    });
});



function snapshot(over: Partial<SessionWorkflowRunSnapshotV1>): SessionWorkflowRunSnapshotV1 {
    return makeSessionWorkflowRunSnapshot({ runId: 'run1', title: 'Implement', ...over });
}

describe('computeWorkflowPhaseRollup', () => {
    it('counts agents by status', () => {
        const rollup = computeWorkflowPhaseRollup([
            { rowId: '1', runId: 'r', agentId: 'a', title: 'A', status: 'complete' },
            { rowId: '2', runId: 'r', agentId: 'b', title: 'B', status: 'active' },
            { rowId: '3', runId: 'r', agentId: 'c', title: 'C', status: 'failed' },
            { rowId: '4', runId: 'r', agentId: 'd', title: 'D', status: 'blocked' },
            { rowId: '5', runId: 'r', agentId: 'e', title: 'E', status: 'pending' },
        ]);
        expect(rollup).toMatchObject({ total: 5, complete: 1, active: 1, failed: 1, blocked: 1, pending: 1 });
    });
});

describe('groupWorkflowAgentsByPhase', () => {
    it('groups agents into ordered phases by membership', () => {
        const snap = snapshot({
            phases: [
                { id: 'p2', title: 'Implementation', order: 2, agentIds: ['ag2'] },
                { id: 'p1', title: 'Research', order: 1, agentIds: ['ag1'] },
            ],
            agents: [
                { id: 'ag1', title: 'web_search', status: 'complete', updatedAt: 1 },
                { id: 'ag2', title: 'editor', status: 'active', updatedAt: 1 },
            ],
            totalAgents: 2,
            completedAgents: 1,
        });
        const groups = groupWorkflowAgentsByPhase(snap);
        expect(groups.map((g) => g.title)).toEqual(['Research', 'Implementation']);
        expect(groups[0]?.agents.map((a) => a.agentId)).toEqual(['ag1']);
        expect(groups[0]?.rollup.complete).toBe(1);
        expect(groups[1]?.agents[0]?.rowId).toBe(agentRowId('ag2'));
    });

    it('returns no groups when there are no phases', () => {
        const snap = snapshot({ agents: [{ id: 'x', title: 'X', status: 'active', updatedAt: 1 }] });
        expect(groupWorkflowAgentsByPhase(snap)).toEqual([]);
    });
});

describe('buildWorkflowActivityRows', () => {
    it('emits phase-primary rows (header + agents) with stable run-scoped ids', () => {
        const snap = snapshot({
            phases: [
                { id: 'p1', title: 'Research', order: 1, agentIds: ['ag1'] },
                { id: 'p2', title: 'Implementation', order: 2, agentIds: ['ag2'] },
            ],
            agents: [
                { id: 'ag1', title: 'web_search', status: 'complete', updatedAt: 1 },
                { id: 'ag2', title: 'editor', status: 'active', updatedAt: 1 },
            ],
        });
        const rows = buildWorkflowActivityRows(snap);
        expect(rows.map((r) => `${r.kind}:${r.rowId}`)).toEqual([
            'phaseHeader:run1:phase:p1',
            `agent:${agentRowId('ag1')}`,
            'phaseHeader:run1:phase:p2',
            `agent:${agentRowId('ag2')}`,
        ]);
    });

    it('emits bare agent rows (no phase header) when there are no phases', () => {
        const snap = snapshot({
            agents: [
                { id: 'a', title: 'A', status: 'active', updatedAt: 1 },
                { id: 'b', title: 'B', status: 'pending', updatedAt: 1 },
            ],
        });
        const rows = buildWorkflowActivityRows(snap);
        expect(rows.every((r) => r.kind === 'agent')).toBe(true);
        expect(rows.map((r) => r.rowId)).toEqual([agentRowId('a'), agentRowId('b')]);
    });

    it('puts unphased agents in an explicit fallback group instead of under the last phase', () => {
        const snap = snapshot({
            phases: [
                { id: 'p1', title: 'Research', order: 1, agentIds: ['ag1'] },
                { id: 'p2', title: 'Assess', order: 2, agentIds: [] },
            ],
            agents: [
                { id: 'ag1', title: 'in phase', status: 'active', updatedAt: 1 },
                { id: 'orphan', title: 'no phase', status: 'pending', updatedAt: 1 },
            ],
        });
        const rows = buildWorkflowActivityRows(snap);
        expect(rows.map((r) => r.rowId)).toEqual([
            'run1:phase:p1',
            agentRowId('ag1'),
            'run1:phase:p2',
            'run1:phase:unassigned',
            agentRowId('orphan'),
        ]);
        expect(rows[3]).toMatchObject({
            kind: 'phaseHeader',
            phaseId: 'unassigned',
            fallback: 'activity',
        });
    });
});

describe('tone + progress helpers', () => {
    // Run status -> tone is NOT owned here. It is `resolveAgentActivityTone(fromWorkflowRunStatus(…))`
    // in the protocol, consumed by the composer badge (`sessionActivityPresentation.test.ts`) and by
    // the shared row. A second mapping in this file painted `blocked` as a warning while the row
    // beside it painted the same run pending, so it was removed rather than re-pinned here.

    it('meter tone reflects worst-case agent status', () => {
        const rollup = (over: Partial<ReturnType<typeof computeWorkflowPhaseRollup>>) => ({
            total: 0, complete: 0, failed: 0, blocked: 0, active: 0, pending: 0, cancelled: 0, unknown: 0, ...over,
        });
        expect(resolveWorkflowMeterTone(rollup({ total: 2, failed: 1 }))).toBe('danger');
        expect(resolveWorkflowMeterTone(rollup({ total: 2, blocked: 1 }))).toBe('warning');
        expect(resolveWorkflowMeterTone(rollup({ total: 2, complete: 2 }))).toBe('success');
        expect(resolveWorkflowMeterTone(rollup({ total: 2 }))).toBe('neutral');
    });

    it('progress fraction clamps to 0..1', () => {
        expect(resolveWorkflowProgressFraction({ completedAgents: 0, totalAgents: 0 })).toBe(0);
        expect(resolveWorkflowProgressFraction({ completedAgents: 2, totalAgents: 4 })).toBe(0.5);
        expect(resolveWorkflowProgressFraction({ completedAgents: 9, totalAgents: 4 })).toBe(1);
    });

    it('computeWorkflowRunRollup totals all agents in the run', () => {
        const snap = snapshot({
            agents: [
                { id: 'a', title: 'A', status: 'complete', updatedAt: 1 },
                { id: 'b', title: 'B', status: 'active', updatedAt: 1 },
                { id: 'c', title: 'C', status: 'failed', updatedAt: 1 },
            ],
        });
        expect(computeWorkflowRunRollup(snap)).toMatchObject({ total: 3, complete: 1, active: 1, failed: 1 });
    });
});

describe('resolveActiveWorkflowPhasePosition', () => {
    it('returns the first phase with a non-complete agent (1-based)', () => {
        const snap = snapshot({
            phases: [
                { id: 'p1', title: 'Research', order: 1, agentIds: ['a'] },
                { id: 'p2', title: 'Implement', order: 2, agentIds: ['b'] },
                { id: 'p3', title: 'Review', order: 3, agentIds: ['c'] },
            ],
            agents: [
                { id: 'a', title: 'A', status: 'complete', updatedAt: 1 },
                { id: 'b', title: 'B', status: 'active', updatedAt: 1 },
                { id: 'c', title: 'C', status: 'pending', updatedAt: 1 },
            ],
        });
        expect(resolveActiveWorkflowPhasePosition(snap)).toEqual({ index: 2, total: 3, title: 'Implement' });
    });

    it('falls back to the last phase when every phase is complete', () => {
        const snap = snapshot({
            phases: [
                { id: 'p1', title: 'Research', order: 1, agentIds: ['a'] },
                { id: 'p2', title: 'Implement', order: 2, agentIds: ['b'] },
            ],
            agents: [
                { id: 'a', title: 'A', status: 'complete', updatedAt: 1 },
                { id: 'b', title: 'B', status: 'complete', updatedAt: 1 },
            ],
        });
        expect(resolveActiveWorkflowPhasePosition(snap)).toEqual({ index: 2, total: 2, title: 'Implement' });
    });

    it('returns null when there are no phases', () => {
        const snap = snapshot({ agents: [{ id: 'a', title: 'A', status: 'active', updatedAt: 1 }] });
        expect(resolveActiveWorkflowPhasePosition(snap)).toBeNull();
    });
});
