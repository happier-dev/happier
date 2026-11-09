import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { NO_SESSION_AGENT_ACTIVITY_ATTENTION } from '@/sync/domains/session/agentActivity';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';

import { projectSessionWorkMap, readWorkFoldedFromMap } from './workMapProducer';
import { endsWithQuietTime } from './workProjection';
import { projectWork, type WorkProjectionInput, type WorkReportSessionSource } from './workProjection';

function report(sessionId: string, managerSessionId: string): WorkReportSessionSource {
    const now = Date.now();
    return {
        sessionId,
        managerSessionId,
        title: sessionId,
        agentId: null,
        facts: [],
        statusFacts: readSessionWorkStatusFacts(createSessionListRenderableSessionFixture({ id: sessionId, active: true,
            activeAt: now, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: now }), now),
        stalled: false,
        archived: false,
    };
}

function input(overrides: Partial<WorkProjectionInput>): WorkProjectionInput {
    return {
        sessionId: 'lead',
        reportSessions: [],
        agentEntries: [],
        workflowHeadlineRuns: [],
        managedRuns: [],
        ownTriggerRunIds: new Set(),
        describeAgentStatus: (entry) => entry.status,
        describeProgress: ({ completed, total }) => `${completed} of ${total}`,
        ...overrides,
    };
}

describe('projectSessionWorkMap', () => {
    it('places reports under their lead and runs under the lead, through the one map contract', () => {
        const projection = projectWork(input({
            reportSessions: [report('api', 'lead'), report('ledger', 'api')],
            managedRuns: [{ run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running', workflowCustodyState: null }), title: 'Review each file', word: 'Running' }],
            agentEntries: [{
                id: 'run:scout', kind: 'execution_run', status: 'running', title: 'Scout', metaDetail: null,
                startedAtMs: null, endedAtMs: null, provenance: 'local', detailState: 'loaded', parentId: null,
                runId: 'scout', sidechainId: null, subagentId: null, attentionKinds: NO_SESSION_AGENT_ACTIVITY_ATTENTION,
            }],
        }));
        const map = projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Payments v2 rollout', projection });

        expect(map.rootNodeIds).toEqual(['session:lead']);
        expect(map.nodesById.get('session:lead')?.childNodeIds).toEqual(['session:api', 'run:run-1', 'agent:run:scout']);
        expect(map.nodesById.get('session:ledger')).toMatchObject({ parentNodeId: 'session:api', depth: 2 });
        expect(map.nodesById.get('run:run-1')?.open).toEqual({ kind: 'run', runId: 'run-1' });
        // The lead says what it waits on but is never tinted for it (S-6).
        expect(map.nodesById.get('session:lead')?.status).toMatchObject({ tone: 'neutral', bucket: 'working' });
    });

    it('draws only the lead when nothing was started — no inferred edges', () => {
        const map = projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Solo', projection: projectWork(input({})) });
        expect(map.nodes.map((node) => node.nodeId)).toEqual(['session:lead']);
    });
});

function finished(sessionId: string, managerSessionId: string): WorkReportSessionSource {
    const now = Date.now();
    return {
        ...report(sessionId, managerSessionId),
        statusFacts: readSessionWorkStatusFacts(createSessionListRenderableSessionFixture({ id: sessionId, active: true,
            activeAt: now, latestTurnStatus: 'completed', latestTurnStatusObservedAt: now }), now),
    };
}

describe('finished work folds out of the map (lab session-A2 / B / C)', () => {
    it('keeps List settled and Map folded after a completed worker stops or its presence expires', () => {
        const now = 1_000_000;
        for (const presence of ['online', 0, undefined] as const) {
            for (const active of [true, false]) {
                const session = createSessionListRenderableSessionFixture({ id: 'runbook', active,
                    activeAt: now - 60_000, presence, latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: now - 1_000,
                    metadata: { path: '/repo', host: 'worker', lifecycleState: 'stopped' } });
                const projection = projectWork(input({ reportSessions: [{
                    ...report('runbook', 'lead'), atMs: now - 1_000,
                    statusFacts: readSessionWorkStatusFacts(session, now),
                }] }));
                expect(projection.sessions[0]?.status).toMatchObject({ state: 'ready', bucket: 'finished' });
                expect(endsWithQuietTime(projection.sessions[0]!)).toBe(true);
                expect(projection.summary.outstanding).toBe(0);
                expect(readWorkFoldedFromMap(projection).map(item => item.key)).toEqual(['session:runbook']);
                const map = projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Lead', projection });
                expect(map.nodesById.has('session:runbook')).toBe(false);
            }
        }
    });

    it('leaves finished leaves out of the map and lists them as folded, while List keeps them', () => {
        const projection = projectWork(input({
            reportSessions: [report('api', 'lead'), finished('runbook', 'lead')],
            managedRuns: [{ run: createWorkflowRunSummaryFixture({ id: 'run-done', state: 'succeeded', workflowCustodyState: null }), title: 'Review each file', word: 'Completed' }],
        }));
        const map = projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Payments v2 rollout', projection });
        expect(map.nodesById.get('session:lead')?.childNodeIds).toEqual(['session:api']);
        expect(readWorkFoldedFromMap(projection).map((item) => item.key)).toEqual(['session:runbook', 'run:run-done']);
        expect(projection.sessions.map((item) => item.key)).toContain('session:runbook');
    });

    it('leaves a settled node without the state word its Work row replaces with a quiet time', () => {
        const settled = { ...finished('api', 'lead'), atMs: Date.now() - 18 * 60_000 };
        const projection = projectWork(input({ reportSessions: [settled, report('ledger', 'api')] }));
        expect(projection.sessions.find((item) => item.key === 'session:api')?.status.word).toBeTruthy();
        const map = projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Payments v2 rollout', projection });
        expect(map.nodesById.get('session:api')?.status).toBeNull();
        expect(map.nodesById.get('session:ledger')?.status?.bucket).toBe('working');
        // Still in the map because work goes under it, so it reads settled instead of working.
        expect(map.nodesById.get('session:api')).toMatchObject({ settled: true });
        expect(map.nodesById.get('session:ledger')).toMatchObject({ settled: false });
    });

    it('folds a report that is quiet with nothing to act on, the way its List row ends with a time', () => {
        const quiet = { ...report('api', 'lead'), atMs: Date.now() - 6 * 60_000,
            statusFacts: readSessionWorkStatusFacts(createSessionListRenderableSessionFixture({ id: 'api', active: true,
                activeAt: Date.now(), latestTurnStatus: 'completed', latestTurnStatusObservedAt: Date.now() }), Date.now()) };
        const projection = projectWork(input({ reportSessions: [quiet, report('ledger', 'lead')] }));
        const quietItem = projection.sessions.find((item) => item.key === 'session:api');
        expect(quietItem && endsWithQuietTime(quietItem)).toBe(true);
        expect(readWorkFoldedFromMap(projection).map((item) => item.key)).toEqual(['session:api']);
    });

    it('keeps a finished session that still has work going under it, so nothing is orphaned', () => {
        const projection = projectWork(input({ reportSessions: [finished('api', 'lead'), report('ledger', 'api')] }));
        const map = projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Payments v2 rollout', projection });
        expect(map.nodesById.get('session:api')?.childNodeIds).toEqual(['session:ledger']);
        expect(readWorkFoldedFromMap(projection)).toEqual([]);
    });
});

function nativeAgent(id: string, kind: 'subagent' | 'agent_team_member', status: 'running' | 'succeeded', subagentId: string | null = id) {
    return {
        id, kind, status, title: id, metaDetail: null, startedAtMs: null, endedAtMs: null, provenance: 'local' as const,
        detailState: 'loaded' as const, parentId: null, runId: null, sidechainId: null, subagentId,
        attentionKinds: NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    };
}

describe('in-session native agents on the map (A-05)', () => {
    it('draws a running subagent and teammate under the lead with the one open path the Work list uses', () => {
        const projection = projectWork(input({
            agentEntries: [nativeAgent('scout', 'subagent', 'running'), nativeAgent('mira', 'agent_team_member', 'running')],
        }));
        expect(projection.summary.outstanding).toBe(2);
        const map = projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Lead', projection });
        expect(map.nodesById.get('session:lead')?.childNodeIds).toEqual(['agent:scout', 'agent:mira']);
        expect(map.nodesById.get('agent:scout')).toMatchObject({ kind: 'agent', settled: false, parentNodeId: 'session:lead' });
        // The view resolves a node through its Work item, whose target the Work opener already handles.
        expect(projection.agents.find((item) => item.key === 'agent:scout')?.open)
            .toEqual({ kind: 'agent_activity', entryId: 'scout', subagentId: 'scout', runId: null });
    });

    it('folds a settled native agent away like any settled work, and names it as folded', () => {
        const projection = projectWork(input({
            agentEntries: [nativeAgent('scout', 'subagent', 'running'), nativeAgent('mira', 'agent_team_member', 'succeeded')],
        }));
        const map = projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Lead', projection });
        expect(map.nodesById.get('session:lead')?.childNodeIds).toEqual(['agent:scout']);
        expect(readWorkFoldedFromMap(projection).map((item) => item.key)).toEqual(['agent:mira']);
        expect(projection.agents.map((item) => item.key)).toContain('agent:mira');
    });
});
