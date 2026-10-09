import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adoptHomeProfile, setActiveServerId, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    resolveExactServerScopedMachine,
    resolvePortableMachineAdministrationTarget,
    resolveServerScopedMachines,
} from './resolveServerScopedMachines';

type TestMachine = Readonly<{ id: string; activeAt: number; revokedAt: number | null }>;
const identity = 'srv_machine_inventory_owner';
let profile: ServerProfile;

function createMachine(id: string, activeAt: number): TestMachine {
    return { id, activeAt, revokedAt: null };
}

describe('resolveServerScopedMachines', () => {
    beforeEach(async () => {
        profile = await adoptHomeProfile({ descriptor: {
            v: 1, homeServerIdentityId: identity,
            canonicalServerUrl: 'https://machine-inventory-owner.example.test',
            revision: 1, endpoints: [{ kind: 'https', url: 'https://machine-inventory-owner.example.test' }],
        }, source: 'manual' });
        expect(profile.id).not.toBe(identity);
        await setActiveServerId(profile.id);
    });
    afterEach(() => standardCleanup());

    it('prefers live active-server machines over a stale scoped cache when the requested server id is an active-server alias', () => {
        const freshMachine = createMachine('machine-live', 200);
        const staleMachine = createMachine('machine-stale', 100);
        expect(resolveServerScopedMachines({
            serverId: identity, activeServerId: profile.id, activeMachines: [freshMachine],
            machineListByServerId: { [identity]: [staleMachine] },
        })).toEqual([freshMachine]);
    });

    it.each([true, false])('uses canonical settled inventory for both equivalent routes, canonical contains machine = %s', (containsMachine) => {
        const machine = createMachine('machine-review', 100);
        const canonicalRows = containsMachine ? [machine] : [];
        const machineListByServerId = {
            [identity]: canonicalRows, [profile.id]: containsMachine ? [] : [machine],
        };
        const machineListStatusByServerId = { [identity]: 'idle' as const, [profile.id]: 'idle' as const };
        for (const serverId of [identity, profile.id]) {
            const context = { serverId, activeServerId: 'foreign-home', activeMachines: [], machineListByServerId, machineListStatusByServerId };
            expect(resolveServerScopedMachines(context)).toBe(canonicalRows);
            expect(resolveExactServerScopedMachine({ ...context, machineId: machine.id })).toBe(containsMachine ? machine : null);
        }
        expect(resolvePortableMachineAdministrationTarget({
            target: { serverIdentityId: identity, machineId: machine.id },
            activeServerId: 'foreign-home', activeMachines: [], machineListByServerId, machineListStatusByServerId,
        })).toMatchObject({ kind: containsMachine ? 'resolved' : 'missingMachine' });
    });

    it('keeps canonical priority without list-status evidence instead of selecting a nonempty alias', () => {
        const machine = createMachine('machine-stale', 100);
        for (const serverId of [identity, profile.id]) {
            expect(resolveExactServerScopedMachine({
                machineId: machine.id, serverId, activeServerId: 'foreign-home', activeMachines: [],
                machineListByServerId: { [identity]: [], [profile.id]: [machine] },
            })).toBeNull();
        }
    });

    it('retains active hydration fallback for an unqualified empty scoped snapshot', () => {
        const machine = createMachine('machine-active', 100);
        expect(resolveServerScopedMachines({
            serverId: identity, activeServerId: profile.id, activeMachines: [machine],
            machineListByServerId: { [identity]: [] },
        })).toEqual([machine]);
    });

    it('preserves active fallback while canonical inventory is loading, but settled absence wins', () => {
        const machine = createMachine('machine-live', 100);
        for (const serverId of [identity, profile.id]) {
            const context = { machineId: machine.id, serverId, activeServerId: profile.id, activeMachines: [machine] };
            for (const loadingRows of [null, []]) {
                expect(resolveExactServerScopedMachine({ ...context,
                    machineListByServerId: { [identity]: loadingRows }, machineListStatusByServerId: { [identity]: 'loading' },
                })).toBe(machine);
            }
            expect(resolveExactServerScopedMachine({ ...context,
                machineListByServerId: { [identity]: [] }, machineListStatusByServerId: { [identity]: 'idle' },
            })).toBeNull();
        }
    });

    it('uses settled inventory to reject a portable target missing from the list despite a stale active row', () => {
        const stale = createMachine('machine-gone', 200);
        const other = createMachine('machine-other', 100);
        expect(resolvePortableMachineAdministrationTarget({
            target: { serverIdentityId: identity, machineId: stale.id },
            activeServerId: profile.id, activeMachines: [stale],
            machineListByServerId: { [identity]: [other] }, machineListStatusByServerId: { [identity]: 'idle' },
        })).toMatchObject({ kind: 'missingMachine' });
    });

    it('returns only the requested machine from the resolved server scope when machine ids repeat across servers', () => {
        const activeMachine = createMachine('machine-shared', 200);
        const remoteMachine = createMachine('machine-shared', 100);
        const context = { serverId: 'server-b', activeServerId: profile.id,
            activeMachines: [activeMachine], machineListByServerId: { 'server-b': [remoteMachine] } };
        expect(resolveExactServerScopedMachine({ ...context, machineId: 'machine-shared' })).toBe(remoteMachine);
        expect(resolveExactServerScopedMachine({ ...context, machineId: 'missing' })).toBeNull();
    });

    it('routes a portable administration target through this device local profile without falling back to an active duplicate machine id', () => {
        const activeDuplicate = createMachine('machine-shared', 200);
        const remoteDuplicate = createMachine('machine-shared', 100);
        expect(resolvePortableMachineAdministrationTarget({
            target: { serverIdentityId: identity, machineId: 'machine-shared' },
            activeServerId: 'foreign-home', activeMachines: [activeDuplicate],
            machineListByServerId: { [profile.id]: [remoteDuplicate] },
        })).toMatchObject({
            kind: 'resolved', target: { serverIdentityId: identity, machineId: 'machine-shared' },
            serverId: profile.id, profile: { id: profile.id, serverIdentityId: identity }, machine: remoteDuplicate,
        });
    });

    it('resolves a non-active portable target from the canonical identity cache key instead of falsely reporting it missing', () => {
        const exactMachine = createMachine('machine-b', 100);
        expect(resolvePortableMachineAdministrationTarget({
            target: { serverIdentityId: identity, machineId: exactMachine.id },
            activeServerId: 'foreign-home', activeMachines: [], machineListByServerId: { [identity]: [exactMachine] },
        })).toMatchObject({ kind: 'resolved', serverId: profile.id, machine: exactMachine });
    });

    it('returns an exact revoked row to Administration instead of applying the visible-machine filter', () => {
        const revoked = { id: 'machine-revoked', activeAt: 50, revokedAt: 90 };
        expect(resolvePortableMachineAdministrationTarget({
            target: { serverIdentityId: identity, machineId: revoked.id },
            activeServerId: 'foreign-home', activeMachines: [], machineListByServerId: { [identity]: [revoked] },
        })).toMatchObject({ kind: 'resolved', machine: revoked });
    });
});
