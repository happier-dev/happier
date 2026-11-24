import { describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { buildMachineActivityPlaceholder } from '@/sync/domains/machines/machineActivity';

import { readApprovalOriginMachineId, readApprovalSessionEndpointLabels, readApprovalTargetEndpointLabels } from './approvalEndpointLabels';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';

// The presence shell a heartbeat leaves for a machine this device never read (another Home, offline).
const unread = buildMachineActivityPlaceholder({ id: 'machine-a', active: false, activeAt: 1 });

describe('approval endpoint labels', () => {
    it('does not substitute the effect Machine for an unread asking Session Machine', () => {
        // W30-B: machines.services.list targets a different Machine from the asking Session.
        const request = ApprovalRequestV2Schema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'asking-session' },
            actionId: 'machines.services.list', actionArgs: { machineId: 'effect-machine' },
            summary: 'List Machine services',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
                serverId: 'home', accountId: 'account', sessionId: 'asking-session', machineId: 'effect-machine',
                actionId: 'machines.services.list', requestId: 'request',
                caller: { kind: 'session', sessionId: 'asking-session', starterDepth: 0, turnDepth: 0 } },
        });
        const body = { family: 'built_in' as const, request };
        expect(readApprovalOriginMachineId(body, 'asking-session')).toBe('');
        // A sessionless daemon still has a real origin Machine to name.
        expect(readApprovalOriginMachineId(body, '')).toBe('effect-machine');
    });
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
