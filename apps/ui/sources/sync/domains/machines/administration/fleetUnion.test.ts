import { afterEach, describe, expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import { isMachineSelectableForFleet, resolveFleetMachineRejection, resolveFleetReadState, resolveFleetSupplyAgreement } from './fleetUnion';

afterEach(clearMachineRequestReachabilityForTest);

describe('Administration fleet policy', () => {
    it('admits only current reachable unlocked identities under their exact Home', () => {
        const machine = createMachineFixture({ id: 'fleet-member', active: true, activeAt: Date.now() });
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        recordMachineRequestFailed({ ...scope, machineId: machine.id });
        expect(isMachineSelectableForFleet(scope, machine)).toBe(false);
        expect(resolveFleetMachineRejection({ serverIdentityId: scope.serverId, machineId: machine.id,
            machineSnapshots: [{ kind: 'resolved', accountId: scope.accountId, profileId: scope.serverId,
                serverIdentityId: scope.serverId, serverName: 'Studio', observation: 'live', machines: [machine] }] }))
            .toBe('home_unreachable');
        expect(isMachineSelectableForFleet({ ...scope, serverId: 'home-b' }, machine)).toBe(true);
        expect(isMachineSelectableForFleet({ ...scope, accountId: 'account-b' }, machine)).toBe(true);
        recordMachineRequestSucceeded({ ...scope, machineId: machine.id });
        expect(isMachineSelectableForFleet(scope, machine)).toBe(true);
        expect(isMachineSelectableForFleet(scope, { ...machine, replacedByMachineId: 'successor' })).toBe(false);
        expect(isMachineSelectableForFleet(scope, { ...machine, availability: { kind: 'locked' } })).toBe(false);
    });

    it('distinguishes an unobserved absence from a settled removal and stale retained inventory', () => {
        const machine = createMachineFixture({ id: 'fleet-member', active: true, activeAt: Date.now() });
        const snapshot = { kind: 'resolved', accountId: 'account-a', profileId: 'home-a', serverIdentityId: 'srv_home_a', serverName: 'Studio',
            observation: 'live', machines: [] } as const;
        const target = { serverIdentityId: 'srv_home_a', machineId: machine.id };
        expect(resolveFleetMachineRejection({ ...target, machineSnapshots: [snapshot] })).toBe('unknown');
        expect(resolveFleetMachineRejection({ ...target, machineSnapshots: [{ ...snapshot, settled: true }] })).toBe('missing');
        expect(resolveFleetMachineRejection({ ...target, machineSnapshots: [{ ...snapshot, observation: 'stale', machines: [machine] }] })).toBe('stale');
    });

    it('preserves a known transport refusal over stale inventory and restores stale classification after recovery', () => {
        const machine = createMachineFixture({ id: 'retained-source', active: true, activeAt: Date.now() });
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const read = (observation: 'stale' | 'live') => resolveFleetMachineRejection({
            serverIdentityId: scope.serverId, machineId: machine.id,
            machineSnapshots: [{ kind: 'resolved', accountId: scope.accountId, profileId: scope.serverId,
                serverIdentityId: scope.serverId, serverName: 'Studio', observation, machines: [machine] }],
        });
        recordMachineRequestFailed({ ...scope, machineId: machine.id });
        expect(read('stale')).toBe('home_unreachable');
        recordMachineRequestSucceeded({ ...scope, machineId: machine.id });
        expect(read('stale')).toBe('stale');
        expect(read('live')).toBeNull();
    });

    it('compares only selectable supplies without electing one of the disagreeing members', () => {
        const current = { id: 'service', content: 'current' };
        const retained = { id: 'service', content: 'old' };
        const resolve = (selectable: boolean) => resolveFleetSupplyAgreement({
            supplies: [{ value: current, selectable: true }, { value: retained, selectable }],
            identity: value => value.id, content: value => value.content,
        });
        expect(resolve(false).conflictingIdentities).toEqual([]);
        const disagreement = resolve(true);
        expect(disagreement.conflictingIdentities).toEqual(['service']);
        expect([...disagreement.variantsByIdentity.get('service')!.values()]).toEqual([current, retained]);
    });

    it('keeps pending and partially retrying coverage resolving while preserving genuine failures', () => {
        expect(resolveFleetReadState(['current', 'resolving'])).toBe('resolving');
        expect(resolveFleetReadState(['current', 'transportFailure'])).toBe('resolving');
        expect(resolveFleetReadState(['transportFailure'])).toBe('failed');
        expect(resolveFleetReadState(['current', 'failed'])).toBe('failed');
        expect(resolveFleetReadState([])).toBe('current');
    });
});
