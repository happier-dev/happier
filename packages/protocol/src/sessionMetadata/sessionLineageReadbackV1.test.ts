import { describe, expect, it } from 'vitest';

import { readSessionLineageReadbackV1 } from './sessionLineageReadbackV1.js';

describe('readSessionLineageReadbackV1', () => {
    it('projects role, origin, run link, and a Lead team-assembly record for status and list rows', () => {
        const teamAssemblyV1 = { v: 1, assignmentId: 'a1', created: [{ role: 'reviewer', sessionId: 'r1' }], skipped: [], failed: [], completedAt: 3 };
        expect(readSessionLineageReadbackV1({
            sessionRoleV1: { v: 1, role: 'reviewer', instructions: 'Review.', assignmentId: 'a9', assignedAt: 1 },
            sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: 'lead', via: { kind: 'team_assembly', assignmentId: 'a1' } },
            executionRunLinkV1: { v: 1, parentSessionId: 'lead', runId: 'run_1', turnEpoch: 0 },
            teamAssemblyV1,
        })).toEqual({
            role: { id: 'reviewer', name: 'Reviewer', assignmentId: 'a9' },
            origin: { creatorSessionId: 'lead', via: { kind: 'team_assembly', assignmentId: 'a1' } },
            executionRunLink: { parentSessionId: 'lead', runId: 'run_1', deliveryState: 'not_sent' },
            teamAssembly: teamAssemblyV1,
        });
    });

    it('reports null fields for a roleless user-created session and omits teamAssembly without a record', () => {
        expect(readSessionLineageReadbackV1({})).toEqual({ role: null, origin: null, executionRunLink: null });
        expect(readSessionLineageReadbackV1({
            sessionRoleV1: { v: 1, role: 'custom:0b8f1a2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c', name: 'Architect', color: '#112233' },
            sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: 'lead' },
        })).toEqual({
            role: { id: 'custom:0b8f1a2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c', name: 'Architect', assignmentId: null },
            origin: { creatorSessionId: 'lead' },
            executionRunLink: null,
        });
    });
});

describe('readSessionLineageReadbackV1 delivery state (R21)', () => {
    it('exposes the report, relay, and delivery records with the derived delivery state', () => {
        const report = { turnEpoch: 1, reportedAt: 5, ack: 'accepted', attempts: 1 };
        const relay = { turnEpoch: 1, status: 'queued', localId: 'l1', at: 6 };
        const readback = readSessionLineageReadbackV1({
            executionRunLinkV1: { v: 1, parentSessionId: 'lead', runId: 'run_1', turnEpoch: 0, report, relay },
        });
        expect(readback.executionRunLink).toEqual({ parentSessionId: 'lead', runId: 'run_1', report, relay, deliveryState: 'queued' });
    });
});
