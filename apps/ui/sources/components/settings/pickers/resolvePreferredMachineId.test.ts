import { expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { listPreferredMachineIds, resolvePreferredLaunchMachineId } from './resolvePreferredMachineId';

it('ranks only selectable machines online while retaining remembered offline launch intent', () => {
    const now = Date.now();
    const machines = [
        createMachineFixture({ id: 'offline', active: false, activeAt: 1 }),
        createMachineFixture({ id: 'replaced', activeAt: now, replacedByMachineId: 'ready' }),
        createMachineFixture({ id: 'locked', activeAt: now, availability: { kind: 'locked', reason: 'encryption_material_unavailable' } }),
        createMachineFixture({ id: 'ready', activeAt: now }),
    ];
    const input = { machines, recentMachinePaths: [{ machineId: 'offline' }], scope: { serverId: 'preference-home', accountId: 'preference-account' } };
    expect(listPreferredMachineIds({ ...input, onlineOnly: true })).toEqual(['ready']);
    expect(resolvePreferredLaunchMachineId(input)).toBe('ready');
    expect(resolvePreferredLaunchMachineId({ ...input, machines: [machines[0]!] })).toBe('offline');
});

it('defaults to an owned computer instead of a recent managed guest or shared machine', () => {
    const computer = createMachineFixture({ id: 'computer' });
    const guest = createMachineFixture({ id: 'guest', managedMachineRef: { homeId: 'home', managedId: 'managed' } });
    const shared = createMachineFixture({ id: 'shared', isShared: true });
    const input = { machines: [guest, shared, computer], recentMachinePaths: [{ machineId: 'guest' }, { machineId: 'shared' }],
        scope: { serverId: 'home', accountId: 'account' } };
    expect(resolvePreferredLaunchMachineId(input)).toBe('computer');
    expect(resolvePreferredLaunchMachineId({ ...input, machines: [guest, shared] })).toBeNull();
    expect(resolvePreferredLaunchMachineId({ ...input, preferredMachineId: 'guest' })).toBe('guest');
});
