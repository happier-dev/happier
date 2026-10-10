import { describe, expect, it } from 'vitest';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol';
import { projectScheduledWorkflowRows } from './scheduledWorkflowRows';

function set(id: string, nextRunAt: number | null, destination: string, enabled = true) {
    return WorkflowTriggerSetV1Schema.parse({ automationId: id, revision: 1, enabled, health: 'available',
        destinations: { targetSessionIds: [destination], usesOriginSession: false, unresolvedWorkflowRefs: [], leaves: [] },
        triggers: [{ id: `${id}-schedule`, revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
            triggerDefinitionEnvelope: null, kind: 'schedule', nextRunAt,
            schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null } }] });
}

describe('upcoming scheduled work', () => {
    it('orders by the scheduler, retains pending occurrences, and filters by the canonical destination relation', () => {
        const sets = [set('later', 2000, 'here'), set('paused', 500, 'here', false), set('pending', null, 'here'),
            set('other', 700, 'elsewhere'), set('first', 1000, 'here')];
        expect(projectScheduledWorkflowRows(sets).map((row) => row.set.automationId)).toEqual(['other', 'first', 'later', 'pending']);
        expect(projectScheduledWorkflowRows(sets, 'here').map((row) => row.set.automationId)).toEqual(['first', 'later', 'pending']);
    });
});
