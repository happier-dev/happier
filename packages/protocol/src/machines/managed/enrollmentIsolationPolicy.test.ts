import { expect, it } from 'vitest';
import { ManagedMachineEnrollmentIdentityV1Schema, matchesManagedMachineEnrollmentAgentIsolationV1,
  resolveManagedMachineEnrollmentAgentIsolationV1 } from './enrollmentIdentityV1.js';

it('keeps undeclared member provisioning out of dedicated bootstrap requests and child grants', () => {
  const enrollmentIdentity = ManagedMachineEnrollmentIdentityV1Schema.parse({ kind: 'dedicatedDaemonUser',
    username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'preauthorized' });
  const target = { homeId: 'home', machineId: 'guest', enrollmentIdentity };
  const policy = resolveManagedMachineEnrollmentAgentIsolationV1(enrollmentIdentity);
  expect(policy).toEqual({ enabled: true });
  const request = { serverId: target.homeId, machineId: target.machineId, enabled: true };
  expect(matchesManagedMachineEnrollmentAgentIsolationV1(target, request)).toBe(true);
  expect(matchesManagedMachineEnrollmentAgentIsolationV1(target, { ...request, memberProvisioning: 'linuxUsersV1' })).toBe(false);
});
