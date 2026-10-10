import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { NO_SESSION_AGENT_ACTIVITY_ATTENTION } from '@/sync/domains/session/agentActivity';

import { projectSessionWorkMap, readWorkFoldedFromMap } from './workMapProducer';
import { projectWork, type WorkProjectionInput, type WorkReportSessionSource } from './workProjection';

function report(sessionId: string, leadSessionId: string): WorkReportSessionSource {
    return {
        sessionId,
        leadSessionId,
        title: sessionId,
        agentId: null,
        facts: [],
        statusFacts: {
            awareness: { runtime: 'working', operational: { primary: 'working', reasons: ['working'] } },
            word: 'Working',
            settled: false,
        } as unknown as WorkReportSessionSource['statusFacts'],
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
            managedRuns: [{ run: { id: 'run-1', state: 'running' }, title: 'Review each file', word: 'Running', needsAttention: false }],
            agentEntries: [{
                id: 'run:scout', kind: 'execution_run', status: 'running', title: 'Scout', metaDetail: null,
                startedAtMs: null, endedAtMs: null, provenance: 'local', detailState: 'loaded', parentId: null,
                runId: 'scout', sidechainId: null, subagentId: null, attentionKinds: NO_SESSION_AGENT_ACTIVITY_ATTENTION,
            }],
        }));
        const map = projectSessionWorkMap({ leadSessionId: 'lead', leadTitle: 'Payments v2 rollout', projection });

        expect(map.rootNodeIds).toEqual(['session:lead']);
        expect(map.nodesById.get('session:lead')?.childNodeIds).toEqual(['session:api', 'run:run-1', 'agent:run:scout']);
        expect(map.nodesById.get('session:ledger')).toMatchObject({ parentNodeId: 'session:api', depth: 2 });
        expect(map.nodesById.get('run:run-1')?.open).toEqual({ kind: 'run', runId: 'run-1' });
        // The lead stays neutral: it has no state of its own on the map (S-6).
        expect(map.nodesById.get('session:lead')?.status).toBeNull();
    });

    it('draws only the lead when nothing was started — no inferred edges', () => {
        const map = projectSessionWorkMap({ leadSessionId: 'lead', leadTitle: 'Solo', projection: projectWork(input({})) });
        expect(map.nodes.map((node) => node.nodeId)).toEqual(['session:lead']);
    });
});

function finished(sessionId: string, leadSessionId: string): WorkReportSessionSource {
    return {
        ...report(sessionId, leadSessionId),
        statusFacts: {
            awareness: { runtime: 'idle', operational: { primary: 'none', reasons: [] } },
            word: 'Finished its turn',
            settled: true,
        } as unknown as WorkReportSessionSource['statusFacts'],
    };
}

describe('finished work folds out of the map (lab session-A2 / B / C)', () => {
    it('leaves finished leaves out of the map and lists them as folded, while List keeps them', () => {
        const projection = projectWork(input({
            reportSessions: [report('api', 'lead'), finished('runbook', 'lead')],
            managedRuns: [{ run: { id: 'run-done', state: 'succeeded' }, title: 'Review each file', word: 'Completed', needsAttention: false }],
        }));
        const map = projectSessionWorkMap({ leadSessionId: 'lead', leadTitle: 'Payments v2 rollout', projection });
        expect(map.nodesById.get('session:lead')?.childNodeIds).toEqual(['session:api']);
        expect(readWorkFoldedFromMap(projection).map((item) => item.key)).toEqual(['session:runbook', 'run:run-done']);
        expect(projection.sessions.map((item) => item.key)).toContain('session:runbook');
    });

    it('keeps a finished session that still has work going under it, so nothing is orphaned', () => {
        const projection = projectWork(input({ reportSessions: [finished('api', 'lead'), report('ledger', 'api')] }));
        const map = projectSessionWorkMap({ leadSessionId: 'lead', leadTitle: 'Payments v2 rollout', projection });
        expect(map.nodesById.get('session:api')?.childNodeIds).toEqual(['session:ledger']);
        expect(readWorkFoldedFromMap(projection)).toEqual([]);
    });
});
