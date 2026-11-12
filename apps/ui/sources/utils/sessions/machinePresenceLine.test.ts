import { publishMachineActivity } from '@/sync/domains/machines/machineActivity';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => `t:${key}` });
});

import {
  clearMachineRequestReachabilityForTest,
  recordMachineRequestFailed,
  recordMachineRequestSucceeded,
  withdrawMachinePresenceForScope,
  captureMachinePresenceObservation,
} from '@/sync/domains/machines/reachability/machineReachability';
import { describeMachinePresenceLine, projectMachineManagedPresence } from './machinePresenceLine';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';

function answered<Machine extends { active: boolean; activeAt: number }>(machine: Machine): Machine {
  publishMachineActivity(machine, { active: machine.active, activeAt: machine.activeAt }, []);
  return machine;
}

afterEach(() => clearMachineRequestReachabilityForTest());

describe('describeMachinePresenceLine', () => {
  it('keeps all 24 cold rows unknown and promotes only the answered row', () => {
    const scope = { serverId: 'cold-home', accountId: 'cold-account' };
    const machines = Array.from({ length: 24 }, (_, index) => ({
      id: `cold-${index}`, active: true, activeAt: 100, presenceProtocolVersion: 1 as const,
    }));
    const statuses = () => machines.map(machine => describeMachinePresenceLine(machine, 100, null, scope).status);
    expect(statuses()).toEqual(Array(24).fill('unknown'));
    publishMachineActivity(machines[0]!, { active: true, activeAt: 101 }, []);
    expect(statuses()).toEqual(['online', ...Array(23).fill('unknown')]);
  });

  it.each(['asleep', 'starting'] as const)('presents native state %s independently of wake eligibility and custody', state => {
    const machine = answered({ id: 'shared-guest', active: false, activeAt: 0,
      managedInputRuntime: { nativeReady: false, wakeState: null, state } });
    const scope = { serverId: 'home', accountId: 'member' };
    expect(describeMachinePresenceLine(machine, undefined, null, scope)).toMatchObject({
      online: false, status: 'offline', label: state === 'asleep' ? 't:managedPower.asleep' : 't:managedWake.starting',
    });
    expect(describeMachinePresenceLine(answered({ ...machine, active: true, activeAt: Date.now(), managedInputRuntime: { nativeReady: true, wakeState: null, state: null } }), undefined, null, scope))
      .toMatchObject({ online: true, status: 'online', label: 't:settingsOverview.machineOnline' });
  });
  it('keeps negotiated live presence online after several beats without a per-beat push', () => {
    const at = Date.now();
    const machine = answered({ id: 'live', active: true, activeAt: at,
      presenceProtocolVersion: 1 as const });
    expect(describeMachinePresenceLine(machine, at + 180_000, null,
      { serverId: 'home', accountId: 'presence-account' }).online).toBe(true);
  });
  const scope = { serverId: 'home', accountId: 'presence-account' };
  it('presents native Running with a stale desired Start as Offline until the guest is reachable', () => {
    const managed = ManagedMachineV1Schema.parse({ id: 'native', homeId: scope.serverId, custodianAccountId: scope.accountId,
      enrolledMachineId: 'guest', launch: { provider: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1,
        name: 'Build box', choices: {} }, allocation: 'bound', creationState: 'active',
      resource: { contributionRef: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, value: {} },
      desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
      observation: { observedAt: 1, availability: 'present', power: 'running', storage: 'retained' } });
    const machine = answered({ id: 'guest', active: false, activeAt: Date.now(), presenceProtocolVersion: 1 as const });
    const presentation = projectMachineManagedPresence(machine, managed);
    expect(describeMachinePresenceLine(machine, undefined, presentation, scope))
      .toMatchObject({ online: false, status: 'offline', label: 't:settingsOverview.machineOffline' });
    expect(describeMachinePresenceLine(answered({ ...machine, active: true }), undefined, presentation, scope))
      .toMatchObject({ online: true, status: 'online', label: 't:settingsOverview.machineOnline' });
  });
  const now = Date.now();
  const fresh = answered({ id: 'machine', active: true, activeAt: now - 1_000 });
  const stale = answered({
    id: 'machine',
    active: true,
    activeAt: now - 60 * 60 * 1_000,
  });

  it('never reads "Unknown": a live record without its Account scope is quiet, an offline record says Offline', () => {
    // Before the Account scope is known a live record cannot be admitted, so it reads quiet in place.
    expect(describeMachinePresenceLine(fresh, now, null, null)).toMatchObject({ online: false, status: 'unknown', label: '' });
    expect(describeMachinePresenceLine(stale, now, null, null)).toMatchObject({ online: false, status: 'offline', label: 't:settingsOverview.machineOffline' });
    // A socket withdrawal keeps the last-known verdicts.
    withdrawMachinePresenceForScope(scope);
    captureMachinePresenceObservation(scope)([fresh.id]);
    expect(describeMachinePresenceLine(fresh, now, null, scope)).toMatchObject({ online: true, status: 'online' });
    expect(describeMachinePresenceLine(stale, now, null, scope)).toMatchObject({ online: false, status: 'offline' });
  });

  it('says a machine with a fresh heartbeat that this Home could not reach is unreachable from here, not offline', () => {
    // The daemon is alive (fresh heartbeat), but this Home's last request to it failed after that.
    recordMachineRequestFailed({
      serverId: 'home',
      accountId: scope.accountId,
      machineId: 'machine',
      observedAtMs: now,
    });
    const line = describeMachinePresenceLine(fresh, now, null, scope);
    expect(line.online).toBe(false);
    expect(line.label).toBe('t:settingsOverview.machineUnreachableFromHome');
  });

  it('keeps "Offline · last seen" for a stale heartbeat, failed request or not', () => {
    expect(describeMachinePresenceLine(stale, now, null, scope).label).toBe(
      't:settingsOverview.machineOffline',
    );
    recordMachineRequestFailed({
      serverId: 'home',
      accountId: scope.accountId,
      machineId: 'machine',
      observedAtMs: now,
    });
    expect(describeMachinePresenceLine(stale, now, null, scope).label).toBe(
      't:settingsOverview.machineOffline',
    );
  });

  it('reads Online for a fresh heartbeat this Home can reach', () => {
    // Round 18: a 20,286 ms-old heartbeat and a scoped reply 2,101 ms ago.
    recordMachineRequestSucceeded({ ...scope, machineId: fresh.id, observedAtMs: now - 2_101 });
    const line = describeMachinePresenceLine({ ...fresh, activeAt: now - 20_286 }, now, null, scope);
    expect(line.online).toBe(true);
    expect(line.label).toBe('t:settingsOverview.machineOnline');
  });
});
