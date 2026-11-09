import { describe, expect, it } from 'vitest';

import { applyTeamAssemblyV1ToMetadata, planTeamAssemblyV1, readTeamAssemblyV1 } from './teamAssemblyV1.js';

const enabled = { visibleAgentsV1: { v: 1, assembleTeamOnLeadAssignment: true } };

describe('planTeamAssemblyV1', () => {
    it('does nothing while the owner setting is off (the shipped default) or the session is not a Project Manager', () => {
        expect(planTeamAssemblyV1({ leadSessionId: 'lead', leadRole: 'project_lead', assignmentId: 'a1', settings: {}, existingChildren: [] }))
            .toEqual({ kind: 'disabled' });
        expect(planTeamAssemblyV1({ leadSessionId: 'lead', leadRole: 'worker', assignmentId: 'a1', settings: enabled, existingChildren: [] }))
            .toEqual({ kind: 'not_lead' });
    });

    it('plans one idle Reviewer and Worker placeholder with the assembly origin and no first input', () => {
        const plan = planTeamAssemblyV1({ leadSessionId: 'lead', leadRole: 'project_lead', assignmentId: 'a1', settings: enabled, existingChildren: [] });
        expect(plan).toEqual({
            kind: 'assemble',
            assignmentId: 'a1',
            creations: [
                { role: 'reviewer', origin: { v: 1, kind: 'agent', creatorSessionId: 'lead', via: { kind: 'team_assembly', assignmentId: 'a1' } } },
                { role: 'worker', origin: { v: 1, kind: 'agent', creatorSessionId: 'lead', via: { kind: 'team_assembly', assignmentId: 'a1' } } },
            ],
            skipped: [],
        });
    });

    it('carries template controls and dedupes roles', () => {
        const settings = { visibleAgentsV1: { v: 1, assembleTeamOnLeadAssignment: true, teamTemplate: [
            { role: 'reviewer', permissionMode: 'read_only', modelId: 'claude-opus-5-5', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } },
            { role: 'reviewer' },
            { role: 'planner' },
        ] } };
        const plan = planTeamAssemblyV1({ leadSessionId: 'lead', leadRole: 'project_lead', assignmentId: 'a1', settings, existingChildren: [] });
        expect(plan.kind === 'assemble' && plan.creations.map(({ origin: _origin, ...rest }) => rest)).toEqual([
            { role: 'reviewer', permissionMode: 'read_only', modelId: 'claude-opus-5-5', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } },
            { role: 'planner' },
        ]);
    });

    it('is idempotent by assignment and skips roles that already have a placeholder, including archived or removed ones', () => {
        const record = { v: 1 as const, assignmentId: 'a1', created: [{ role: 'worker', sessionId: 'w1' }], skipped: [], failed: [], completedAt: 5 };
        expect(planTeamAssemblyV1({ leadSessionId: 'lead', leadRole: 'project_lead', assignmentId: 'a1', settings: enabled, existingChildren: [], record }))
            .toEqual({ kind: 'already_assembled', record });

        const plan = planTeamAssemblyV1({
            leadSessionId: 'lead', leadRole: 'project_lead', assignmentId: 'a2', settings: enabled, record,
            existingChildren: [
                { sessionId: 'r1', role: 'reviewer', archived: true, origin: { v: 1, kind: 'agent', creatorSessionId: 'lead', via: { kind: 'execution_run', runId: 'run_1' } } },
                { sessionId: 'x', role: 'reviewer', origin: { v: 1, kind: 'agent', creatorSessionId: 'someone-else' } },
            ],
        });
        expect(plan).toEqual({
            kind: 'assemble',
            assignmentId: 'a2',
            creations: [],
            skipped: [
                { role: 'reviewer', reason: 'existing_child', sessionId: 'r1' },
                { role: 'worker', reason: 'existing_child', sessionId: 'w1' },
            ],
        });
    });
});

describe('teamAssemblyV1 metadata record', () => {
    it('round-trips through metadata and reads malformed records as absent', () => {
        const record = { v: 1 as const, assignmentId: 'a1', created: [{ role: 'reviewer', sessionId: 'r1' }], skipped: [{ role: 'worker', reason: 'unsupported' as const }], failed: [], completedAt: 9 };
        const metadata = applyTeamAssemblyV1ToMetadata({ sessionRoleV1: { v: 1, role: 'project_lead' } }, record);
        expect(readTeamAssemblyV1(metadata)).toEqual(record);
        expect(metadata.sessionRoleV1).toEqual({ v: 1, role: 'project_lead' });
        expect(readTeamAssemblyV1({ teamAssemblyV1: { v: 1, assignmentId: '' } })).toBeNull();
    });
});
