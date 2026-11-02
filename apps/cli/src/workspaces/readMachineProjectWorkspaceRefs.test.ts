import { expect, it } from 'vitest';
import { materializeWorkspaceRefForMachineRoot } from './workspaceRefsV1';
import { readMachineProjectWorkspaceRefs } from './readMachineProjectWorkspaceRefs';

it('selects portable Home workspaces from the local-profile projection for isolation and Storage', () => {
  const target = { scopeKey: 'daemon-profile:account', serverId: 'daemon-profile',
    homeServerIdentityId: 'srv_bound_home', machineId: 'machine' };
  const workspaceRefs = [
    { serverId: target.homeServerIdentityId, machineId: target.machineId, rootPath: '/owner' },
    { serverId: 'srv_foreign_home', machineId: target.machineId, rootPath: '/foreign' },
    { serverId: target.homeServerIdentityId, machineId: 'other-machine', rootPath: '/other-machine' },
  ].map((input, index) => materializeWorkspaceRefForMachineRoot([], {
    ...input, nowMs: 1, createId: () => `workspace-${index}`,
  }).workspaceRef);
  const snapshot = { scopeKey: target.scopeKey, workspaceRefs };
  expect(readMachineProjectWorkspaceRefs(snapshot, target)).toEqual([workspaceRefs[0]]);
  expect(readMachineProjectWorkspaceRefs(snapshot, { ...target, scopeKey: 'another-profile:account' })).toBeNull();
  expect(readMachineProjectWorkspaceRefs(snapshot, { ...target, homeServerIdentityId: null })).toEqual([]);
  const local = materializeWorkspaceRefForMachineRoot([], { serverId: target.serverId, machineId: target.machineId,
    rootPath: '/legacy', nowMs: 1, createId: () => 'legacy-workspace' }).workspaceRef;
  expect(readMachineProjectWorkspaceRefs({ ...snapshot, workspaceRefs: [local] }, target)).toEqual([local]);
});
