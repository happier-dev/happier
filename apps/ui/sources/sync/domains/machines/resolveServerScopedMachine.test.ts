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

    it('does not enumerate unrelated active machines for settled scoped lookups', () => {
        const machines = Array.from({ length: 100 }, (_, index) => createMachineFixture({ id: `machine-${index}` }));
        let enumerations = 0;
        const activeMachines = new Proxy(Object.fromEntries(machines.map(machine => [machine.id, machine])), {
            ownKeys(target) { enumerations += 1; return Reflect.ownKeys(target); },
        });
        const state = { machines: activeMachines, machineListByServerId: { 'srv_machine_owner': machines },
            machineListStatusByServerId: { 'srv_machine_owner': 'idle' as const } };
        const start = performance.now();
        for (let update = 0; update < 20; update += 1) {
            for (let row = 0; row < 200; row += 1) {
                expect(resolveServerScopedMachine(state, homeId, machines[row % machines.length]!.id)).toBe(machines[row % machines.length]);
            }
        }
        console.info('[PERF-RENDER machines]', JSON.stringify({ machines: machines.length, lookups: 4000, enumerations, ms: performance.now() - start }));
        expect(enumerations).toBe(0);
        const replacement = createMachineFixture({ id: machines[0]!.id, active: false });
        expect(resolveServerScopedMachine({ ...state, machineListByServerId: { 'srv_machine_owner': [replacement] } }, homeId, replacement.id)).toBe(replacement);
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
