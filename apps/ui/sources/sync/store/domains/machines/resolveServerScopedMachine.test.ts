import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit';
import { resolveServerScopedMachine } from './resolveServerScopedMachine';
import { adoptHomeProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

let homeId: string;

describe('resolveServerScopedMachine', () => {
    beforeEach(async () => {
        const profile = await adoptHomeProfile({ descriptor: {
            v: 1, homeServerIdentityId: 'srv_machine_owner', canonicalServerUrl: 'https://machine-owner.example.test',
            revision: 1, endpoints: [{ kind: 'https', url: 'https://machine-owner.example.test' }],
        }, source: 'manual' });
        homeId = profile.id;
        expect(homeId).not.toBe('srv_machine_owner');
        await setActiveServerId(homeId);
    });
    afterEach(() => standardCleanup());

    it('resolves identity and profile routes from either inventory key', () => {
        const machine = createMachineFixture();
        for (const key of ['srv_machine_owner', homeId]) {
            const state = { machines: {}, machineListByServerId: { [key]: [machine] },
                machineListStatusByServerId: { [key]: 'idle' as const } };
            for (const route of ['srv_machine_owner', homeId]) {
                expect(resolveServerScopedMachine(state, route, machine.id)).toBe(machine);
            }
        }
    });

    it('honors definitive absence for equivalent routes even with a stale global row', () => {
        const machine = createMachineFixture();
        for (const key of ['srv_machine_owner', homeId]) {
            const state = { machines: { [machine.id]: machine }, machineListByServerId: { [key]: [] },
                machineListStatusByServerId: { [key]: 'idle' as const } };
            for (const route of ['srv_machine_owner', homeId, null]) {
                expect(resolveServerScopedMachine(state, route, machine.id)).toBeNull();
            }
        }
    });

    it('uses the canonical identity inventory over an obsolete profile alias in both directions', () => {
        const machine = createMachineFixture();
        for (const canonicalRows of [[machine], []]) {
            const state = { machines: { [machine.id]: machine },
                machineListByServerId: { 'srv_machine_owner': canonicalRows, [homeId]: canonicalRows.length ? [] : [machine] },
                machineListStatusByServerId: { 'srv_machine_owner': 'idle' as const, [homeId]: 'idle' as const } };
            for (const route of ['srv_machine_owner', homeId]) {
                expect(resolveServerScopedMachine(state, route, machine.id)).toBe(canonicalRows[0] ?? null);
            }
        }
    });

    it('does not fall back to a global machine excluded by a settled scoped list', () => {
        const globalMachine = createMachineFixture();

        expect(resolveServerScopedMachine({
            machines: { 'machine-1': globalMachine },
            machineListByServerId: { 'srv_machine_owner': [] },
            machineListStatusByServerId: { 'srv_machine_owner': 'idle' },
        }, 'srv_machine_owner', 'machine-1')).toBeNull();
    });

    it('does not borrow active Home capability while a foreign Home list is loading', () => {
        const globalMachine = createMachineFixture();
        expect(resolveServerScopedMachine({
            machines: { 'machine-1': globalMachine },
            machineListByServerId: { 'server-foreign': null },
            machineListStatusByServerId: { 'server-foreign': 'loading' },
        }, 'server-foreign', 'machine-1')).toBeNull();
    });

    it('preserves the global fallback while a scoped machine list is still loading', () => {
        const globalMachine = createMachineFixture();

        expect(resolveServerScopedMachine({
            machines: { 'machine-1': globalMachine },
            machineListByServerId: { 'srv_machine_owner': null },
            machineListStatusByServerId: { 'srv_machine_owner': 'loading' },
        }, 'srv_machine_owner', 'machine-1')).toBe(globalMachine);
    });
});
