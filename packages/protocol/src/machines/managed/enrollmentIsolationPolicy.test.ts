import { expect, it } from 'vitest';
import { ManagedMachineEnrollmentIdentityV1Schema, matchesManagedMachineEnrollmentAgentIsolationV1,
  resolveManagedMachineEnrollmentAgentIsolationV1 } from './enrollmentIdentityV1.js';
import { MachineAgentIsolationPreviewInputV1Schema, readMachineAgentIsolationPolicyV1,
  resolveMachineAgentExecutionPlacementV1 } from '../agentIsolationV1.js';

// OWNER-RULINGS 2026-11-07: new dedicated enrollment reviews linuxUsersV1 by default.
it('places fresh dedicated enrollment in a member through its reviewed creation child', () => {
  const enrollmentIdentity = ManagedMachineEnrollmentIdentityV1Schema.parse({ kind: 'dedicatedDaemonUser',
    username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'preauthorized' });
  const target = { homeId: 'home', machineId: 'guest', enrollmentIdentity };
  const policy = resolveManagedMachineEnrollmentAgentIsolationV1(enrollmentIdentity);
  expect(policy).toEqual({ enabled: true, memberProvisioning: 'linuxUsersV1' });
  const request = MachineAgentIsolationPreviewInputV1Schema.parse({ serverId: target.homeId, machineId: target.machineId, ...policy });
  expect(matchesManagedMachineEnrollmentAgentIsolationV1(target, request)).toBe(true);
  expect(resolveMachineAgentExecutionPlacementV1({ platform: 'linux', policy: request })).toBe('member');
});

it('keeps an existing enabled record without member provisioning in shared-agent placement', () => {
  const stored = readMachineAgentIsolationPolicyV1({ agentIsolation: { enabled: true } });
  expect(stored).toMatchObject({ status: 'ready', policy: { enabled: true } });
  if (stored.status !== 'ready') throw new Error('Expected the existing policy to remain readable');
  expect(stored.policy).not.toHaveProperty('memberProvisioning');
  expect(resolveMachineAgentExecutionPlacementV1({ platform: 'linux', policy: stored.policy })).toBe('sharedAgent');
});

it('selects shared-agent for the separate-users-off policy on a dedicated Machine', () => {
  // Separate-users off retains physical Agent isolation by omitting the member policy.
  const request = MachineAgentIsolationPreviewInputV1Schema.parse({ machineId: 'guest', enabled: true });
  expect(resolveMachineAgentExecutionPlacementV1({ platform: 'linux', policy: request })).toBe('sharedAgent');
});
