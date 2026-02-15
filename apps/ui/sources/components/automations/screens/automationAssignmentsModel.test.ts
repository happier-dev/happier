import { describe, expect, it } from 'vitest';

import { upsertAutomationAssignmentToggle } from '@/components/automations/screens/automationAssignmentsModel';

describe('upsertAutomationAssignmentToggle', () => {
    it('enables a new machine assignment when machine is not currently assigned', () => {
        const next = upsertAutomationAssignmentToggle({
            assignments: [{ machineId: 'm1', enabled: true, priority: 100, updatedAt: null }],
            machineId: 'm2',
            enabled: true,
        });

        expect(next).toEqual([
            { machineId: 'm1', enabled: true, priority: 100 },
            { machineId: 'm2', enabled: true, priority: 0 },
        ]);
    });

    it('updates enabled flag for existing assignment while preserving priority', () => {
        const next = upsertAutomationAssignmentToggle({
            assignments: [{ machineId: 'm1', enabled: true, priority: 42, updatedAt: null }],
            machineId: 'm1',
            enabled: false,
        });

        expect(next).toEqual([
            { machineId: 'm1', enabled: false, priority: 42 },
        ]);
    });
});
