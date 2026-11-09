import { describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { buildMachineActivityPlaceholder } from '@/sync/domains/machines/machineActivity';

import { readApprovalSessionEndpointLabels, readApprovalTargetEndpointLabels } from './approvalEndpointLabels';

// The presence shell a heartbeat leaves for a machine this device never read (another Home, offline).
const unread = buildMachineActivityPlaceholder({ id: 'machine-a', active: false, activeAt: 1 });

describe('approval endpoint labels', () => {
    it('never name a machine that was not read "Loading…": the request source is left out', () => {
        expect(readApprovalSessionEndpointLabels({ session: null, machine: unread }).machineLabel).toBeNull();
    });

    it('fall back to the identifier the proof carries, never the placeholder', () => {
        expect(readApprovalTargetEndpointLabels({ machineId: 'machine-a', machine: unread, canonicalRoot: '/repo' }).machineLabel)
            .toBe('machine-a');
    });

    it('name a machine once it is read', () => {
        const machine = createMachineFixture({ id: 'machine-a', metadata: { host: 'studio.local', displayName: 'Studio' } as never });
        expect(readApprovalSessionEndpointLabels({ session: null, machine }).machineLabel).toBe('Studio');
        expect(readApprovalTargetEndpointLabels({ machineId: 'machine-a', machine, canonicalRoot: '/repo' }).machineLabel).toBe('Studio');
    });
});
