import { describe, expect, it } from 'vitest';
import { ManagedMachineEnrollmentIdentityV1Schema, matchesManagedMachineEnrollmentAgentIsolationV1,
  resolveManagedMachineEnrollmentAgentIsolationV1 } from './enrollmentIdentityV1.js';

describe('reviewed managed enrollment identity', () => {
  // OWNER-RULINGS 2026-11-07: dedicated managed Machines default to separate users.
  it('binds dedicated creation children to reviewed member provisioning', () => {
    const enrollmentIdentity = ManagedMachineEnrollmentIdentityV1Schema.parse({ kind: 'dedicatedDaemonUser',
      username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'preauthorized' });
    const target = { homeId: 'home', machineId: 'guest', enrollmentIdentity };
    const policy = resolveManagedMachineEnrollmentAgentIsolationV1(enrollmentIdentity);
    expect(policy).toEqual({ enabled: true, memberProvisioning: 'linuxUsersV1' });
    const request = { serverId: 'home', machineId: 'guest', enabled: true, memberProvisioning: 'linuxUsersV1' as const };
    expect(matchesManagedMachineEnrollmentAgentIsolationV1(target, request)).toBe(true);
    expect(matchesManagedMachineEnrollmentAgentIsolationV1(target, { ...request, memberProvisioning: undefined })).toBe(false);
    expect(matchesManagedMachineEnrollmentAgentIsolationV1(target, { ...request, enabled: false })).toBe(false);
    expect(matchesManagedMachineEnrollmentAgentIsolationV1(target, { ...request, machineId: 'neighbor' })).toBe(false);
    expect(matchesManagedMachineEnrollmentAgentIsolationV1(target, { ...request, serverId: 'foreign-home' })).toBe(false);
    for (const identity of [{ kind: 'existingUser', role: 'personal' }, { kind: 'existingUser', role: 'adopted' },
      { kind: 'guestProcess', role: 'sandbox' }]) {
      const enrollmentIdentity = ManagedMachineEnrollmentIdentityV1Schema.parse(identity);
      expect(resolveManagedMachineEnrollmentAgentIsolationV1(enrollmentIdentity)).toBeNull();
      expect(matchesManagedMachineEnrollmentAgentIsolationV1({ ...target, enrollmentIdentity }, request)).toBe(false);
    }
  });

  it('admits the explicit roles and requires a separate named administrator for Ask without retaining secrets', () => {
    const dedicated = { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'preauthorized' };
    const ask = { ...dedicated, adminAccessAtCreation: 'ask', administrator: { username: 'alice.admin' } };
    for (const identity of [dedicated, ask, { ...dedicated, role: 'deployTarget', adminAccessAtCreation: 'none' },
      { kind: 'existingUser', role: 'personal' }, { kind: 'existingUser', role: 'adopted' },
      { kind: 'guestProcess', role: 'sandbox' }]) {
      expect(ManagedMachineEnrollmentIdentityV1Schema.parse(identity)).toEqual(identity);
    }
    for (const identity of [{ ...ask, administrator: undefined }, { ...ask, administrator: { username: '' } },
      { ...ask, administrator: { username: 'root' } }, { ...ask, administrator: { username: 'happier' } },
      { ...ask, administrator: { username: 'alice ALL=(ALL) NOPASSWD: ALL' } },
      { ...ask, administrator: { username: 'alice\nroot' } },
      { ...ask, administrator: { username: 'alice\n' } },
      { ...ask, administrator: { username: 'alice', password: 'not-retained' } },
      { ...dedicated, username: 'root' }, { ...dedicated, serviceMode: 'none' },
      { ...dedicated, password: 'not-retained' }, { kind: 'guestProcess', role: 'server' }]) {
      expect(ManagedMachineEnrollmentIdentityV1Schema.safeParse(identity).success).toBe(false);
    }
  });
});
