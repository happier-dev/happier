import { describe, expect, it, vi } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

const appliedState = vi.hoisted(() => ({ serverId: 'home_a' }));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerId: () => appliedState.serverId,
}));

import { readPeerEndpointForServerScope } from './readPeerEndpointForServerScope';

const focusedEndpoint = { endpointId: 'focused-endpoint' };
const scopedEndpoint = { endpointId: 'scoped-endpoint' };

describe('readPeerEndpointForServerScope', () => {
    const state = {
        machines: {
            shared_machine: createMachineFixture({
                id: 'shared_machine',
                daemonState: { peerMediation: { iroh: { endpoint: focusedEndpoint } } },
            }),
        },
        machineListByServerId: {
            home_b: [createMachineFixture({
                id: 'shared_machine',
                daemonState: { peerMediation: { iroh: { endpoint: scopedEndpoint } } },
            })],
            home_c: [],
        },
    };

    it('uses the focused projection only for the active Home', () => {
        expect(readPeerEndpointForServerScope({
            state,
            serverId: 'home_a',
            machineId: 'shared_machine',
            select: (machine) => machine.daemonState?.peerMediation?.iroh?.endpoint,
        })).toBe(focusedEndpoint);
    });

    it('uses only the target Home projection for a non-focused Home', () => {
        expect(readPeerEndpointForServerScope({
            state,
            serverId: 'home_b',
            machineId: 'shared_machine',
            select: (machine) => machine.daemonState?.peerMediation?.iroh?.endpoint,
        })).toBe(scopedEndpoint);

        expect(readPeerEndpointForServerScope({
            state,
            serverId: 'home_c',
            machineId: 'shared_machine',
            select: (machine) => machine.daemonState?.peerMediation?.iroh?.endpoint,
        })).toBeNull();
    });

});
