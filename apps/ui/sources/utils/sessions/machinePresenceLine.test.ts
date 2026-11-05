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
import { describeMachinePresenceLine } from './machinePresenceLine';

afterEach(() => clearMachineRequestReachabilityForTest());

describe('describeMachinePresenceLine', () => {
  it('keeps negotiated live presence online after several beats without a per-beat push', () => {
    const at = Date.now();
    const machine = { id: 'live', active: true, activeAt: at,
      presenceProtocolVersion: 1 as const };
    expect(describeMachinePresenceLine(machine, at + 180_000, null,
      { serverId: 'home', accountId: 'presence-account' }).online).toBe(true);
  });
  const scope = { serverId: 'home', accountId: 'presence-account' };
  const now = Date.now();
  const fresh = { id: 'machine', active: true, activeAt: now - 1_000 };
  const stale = {
    id: 'machine',
    active: true,
    activeAt: now - 60 * 60 * 1_000,
  };

  it('retains unknown after transport withdrawal until this exact Account observes the Machine again', () => {
    withdrawMachinePresenceForScope(scope);
    expect(describeMachinePresenceLine(fresh, now, null, scope)).toMatchObject({ online: false, status: 'unknown', label: 't:common.unknown' });
    captureMachinePresenceObservation({ ...scope, accountId: 'another-account' })([fresh.id]);
    expect(describeMachinePresenceLine(fresh, now, null, scope).label).toBe('t:common.unknown');
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
