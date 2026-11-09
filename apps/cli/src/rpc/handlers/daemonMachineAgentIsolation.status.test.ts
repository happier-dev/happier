import { expect, it } from 'vitest';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { MachineAgentIsolationPreviewResultV1Schema, type MachineAgentIsolationStatusV1, type MachineAdminAccessV1 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { createAgentIsolationEffectsBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';

it.skipIf(process.platform !== 'linux')('projects the owners member directories under separate users instead of administrator filesystem placement', async () => {
  const target = { serverId: 'fixture-home', machineId: 'fixture-machine', installationId: 'fixture-install', custodianAccountId: 'fixture-owner' };
  const manager = new RpcHandlerManager({ scopePrefix: target.machineId, localMachineId: target.machineId,
    encryptionMode: 'plain', logger() {}, authorizeRequest: async () => ({ ok: true }) });
  registerDaemonMachineAgentIsolationRpcHandlers(manager, { target: () => target,
    readCanonicalHomeServerIdentityId: () => target.serverId,
    read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1',
      status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } }),
    // Native own-status observation is the OS boundary; custody and placement stay real.
    inspectOwn: async ({ requesterIdentity }) => ({ protection: 'member_separated',
      status: { kind: 'effective', platform: 'linux' },
      directories: { home: `/members/${requesterIdentity.requester.accountId}/home`,
        workspace: `/members/${requesterIdentity.requester.accountId}/workspace` } }),
  });
  for (const actorAccountId of ['fixture-owner', 'fixture-member']) {
    expect(await manager.handleRequest({ method: `${target.machineId}:machines.agentIsolation.status`,
      params: { machineId: target.machineId }, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId, custodianAccountId: target.custodianAccountId,
        machineId: target.machineId, installationId: target.installationId, role: 'manage', encryptionMode: 'plain' },
    })).toEqual({ protection: 'member_separated', status: { kind: 'effective', platform: 'linux' },
      directories: { home: `/members/${actorAccountId}/home`, workspace: `/members/${actorAccountId}/workspace` } });
  }
});

it.each([
  [{ version: 1, mode: 'none' }, 'mode_none'],
  [{ version: 1, mode: 'ask', administratorUsername: 'admin' }, 'not_preauthorized'],
  [{ version: 1, mode: 'preauthorized' }, 'managed_cli_unavailable'],
] satisfies readonly (readonly [MachineAdminAccessV1, string])[])(
  'preserves the actual setup prerequisite through the preview Action for %j', async (adminAccess, reasonCode) => {
    const target = { serverId: 'fixture-home', machineId: 'fixture-machine', installationId: 'fixture-install', custodianAccountId: 'fixture-owner' };
    const boundary = createAgentIsolationEffectsBoundary({ installationId: target.installationId,
      installedCli: '/nonexistent-happier-mi2/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
      publishStatus: async () => {}, adminAccess });
    const manager = new RpcHandlerManager({ scopePrefix: target.machineId, localMachineId: target.machineId,
      encryptionMode: 'plain', logger() {}, authorizeRequest: async () => ({ ok: true }) });
    registerDaemonMachineAgentIsolationRpcHandlers(manager, { target: () => target,
      readCanonicalHomeServerIdentityId: () => target.serverId,
      read: () => ({ enabled: false, status: { kind: 'disabled' } }),
      captureMetadataPort: () => ({ read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 1 }),
        compareAndSwap: async () => { throw new Error('Preview must not write metadata'); } }),
      // Keep real elevation policy and managed-executable admission. No process
      // can launch for these refusals; the nonexistent path is the OS boundary.
      effects: { ...boundary.effects, backend: undefined, elevation: { ...boundary.effects.elevation, spawn: undefined } } });
    const executor = createActionExecutor({ machineAgentIsolationAction: async ({ input }) => manager.handleRequest({
      requestId: 'b0ac79a8-b800-485d-9a4f-cd1e8ef8f490',
      method: `${target.machineId}:machines.agentIsolation.preview`, params: input,
      callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'fixture-owner', custodianAccountId: target.custodianAccountId,
        machineId: target.machineId, installationId: target.installationId, role: 'manage', encryptionMode: 'plain' },
    }) } as ActionExecutorDeps);
    const result = await executor.execute('machines.agentIsolation.preview', { machineId: target.machineId,
      enabled: true, memberProvisioning: 'linuxUsersV1' }, { surface: 'ui', serverId: target.serverId });
    expect(result).toMatchObject({ ok: true, result: { kind: 'unavailable', setup: { outcome: 'not_applied', reasonCode } } });
    if (!result.ok) throw new Error(result.errorCode);
    const preview = MachineAgentIsolationPreviewResultV1Schema.parse(result.result);
    expect(preview).toMatchObject({ setup: { reasonCode } });
    if (reasonCode === 'mode_none') expect(preview).toMatchObject({ setup: {
      recovery: { kind: 'configure_admin_access', mode: 'preauthorized' },
    } });
    if (reasonCode === 'managed_cli_unavailable') expect(preview).toMatchObject({ setup: {
      recovery: { kind: 'install_managed_cli', executablePath: '/nonexistent-happier-mi2/current/happier' },
    } });
    expect(boundary.mutations).toEqual([]);
    expect(boundary.launches).toEqual([]);
  });

it('serves own observed protection under current Use admission without provisioning or identity operands', async () => {
  const target = { serverId: 'fixture-home', machineId: 'fixture-machine', installationId: 'fixture-install', custodianAccountId: 'fixture-owner' };
  let current = true;
  let enabled = true;
  let retireAfterRead = false;
  let status: MachineAgentIsolationStatusV1 = { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' };
  const manager = new RpcHandlerManager({ scopePrefix: target.machineId, localMachineId: target.machineId,
    encryptionMode: 'plain', logger() {}, authorizeRequest: async () => current ? { ok: true } : { ok: false, error: 'forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN } });
  // No setup effects or metadata writer exists. This read must still work.
  registerDaemonMachineAgentIsolationRpcHandlers(manager, { target: () => target,
    readCanonicalHomeServerIdentityId: () => target.serverId, read: () => {
    if (retireAfterRead) current = false;
    return { enabled, status };
  } });
  const invoke = (accountId = 'fixture-member', extra: Record<string, unknown> = {}) => manager.handleRequest({
    method: `${target.machineId}:machines.agentIsolation.status`,
    params: { serverId: target.serverId, machineId: target.machineId, ...extra },
    callerAuthority: 'present_user', machineAdmission: { actorAccountId: accountId,
      custodianAccountId: target.custodianAccountId, machineId: target.machineId,
      installationId: target.installationId, role: 'use', encryptionMode: 'plain' },
  });
  const member = await invoke();
  expect(member).toEqual({ protection: 'shared_user', status });
  // Machine RPC is the only substituted system boundary. Both Action dispatch
  // and the registered receiving handler run with their actual internals.
  const executor = createActionExecutor({ machineAgentIsolationAction: async ({ input }) => invoke('fixture-member', input) } as ActionExecutorDeps);
  expect(await executor.execute('machines.agentIsolation.status', { machineId: target.machineId },
    { surface: 'agent', serverId: target.serverId })).toMatchObject({ ok: true, result: member });
  expect(JSON.stringify(member)).not.toContain('fixture-member');
  expect(await invoke('fixture-owner')).toEqual({ protection: 'trusted_administrator', status });
  status = { kind: 'applying', phase: 'runtime_replacement' };
  expect(await invoke()).toEqual({ protection: 'setup_pending', status });
  status = { kind: 'disabled' }; enabled = false;
  expect(await invoke()).toEqual({ protection: 'setup_pending', status });
  status = { kind: 'unavailable', code: 'unsupported_platform' }; enabled = true;
  expect(await invoke()).toEqual({ protection: 'unavailable', status });
  expect(await invoke('fixture-member', { username: 'another-user', home: '/another-member' })).toMatchObject({ error: expect.any(String) });
  expect(await invoke('fixture-member', { machineId: 'another-machine' })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  // This finite read already passed admission. A second Home revalidation
  // after reading the held status would incorrectly discard that result.
  status = { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' };
  retireAfterRead = true;
  expect(await invoke()).toEqual({ protection: 'shared_user', status });
  expect(await invoke()).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
});

it('keeps exact provisioning roots behind Manage while Use reads only own protection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-own-status-preview-'));
  try {
    const target = { serverId: 'fixture-home', machineId: 'fixture-machine', installationId: 'fixture-install', custodianAccountId: 'fixture-owner' };
    let rootsRead = 0;
    const boundary = createAgentIsolationEffectsBoundary({ installationId: target.installationId,
      installedCli: '/opt/happier/cli/current/happier', readRoots: () => { rootsRead++; return [{ rootId: 'private-checkout', path: root }]; },
      readSessionsToReplace: () => 0, publishStatus: async () => {} });
    const manager = new RpcHandlerManager({ scopePrefix: target.machineId, localMachineId: target.machineId,
      encryptionMode: 'plain', logger() {}, authorizeRequest: async () => ({ ok: true }) });
    registerDaemonMachineAgentIsolationRpcHandlers(manager, { target: () => target,
      readCanonicalHomeServerIdentityId: () => target.serverId,
      read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } }),
      captureMetadataPort: () => ({ read: async () => ({ status: 'ready', metadata: { agentIsolation: { enabled: true } }, metadataVersion: 1 }),
        compareAndSwap: async () => ({ status: 'unavailable' }) }), effects: boundary.effects });
    expect(await manager.handleRequest({ method: `${target.machineId}:machines.agentIsolation.status`, params: { machineId: target.machineId },
      callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'fixture-member', custodianAccountId: target.custodianAccountId,
        machineId: target.machineId, installationId: target.installationId, role: 'use', encryptionMode: 'plain' },
    })).toEqual({ protection: 'shared_user', status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } });
    expect(rootsRead).toBe(0);
    const invoke = (actorAccountId: string, role: 'use' | 'manage') => manager.handleRequest({
      method: `${target.machineId}:machines.agentIsolation.preview`, params: { machineId: target.machineId, enabled: true },
      callerAuthority: 'present_user', machineAdmission: { actorAccountId, custodianAccountId: target.custodianAccountId,
        machineId: target.machineId, installationId: target.installationId, role, encryptionMode: 'plain' },
    });
    expect(await invoke('fixture-member', 'use')).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(rootsRead).toBe(0);
    for (const actor of ['fixture-owner', 'fixture-manager']) expect(await invoke(actor, 'manage')).toMatchObject({
      kind: 'ready', plan: { roots: [{ rootId: 'private-checkout', path: root }] },
    });
    expect(boundary.mutations).toEqual([]);
    expect(boundary.launches).toEqual([]);
    expect(resolveMachineRpcRoutePolicy('machines.agentIsolation.status').sharedMachineAccess).toBe('use');
    expect(resolveMachineRpcRoutePolicy('machines.agentIsolation.preview').sharedMachineAccess).toBe('manage');
  } finally { await rm(root, { recursive: true, force: true }); }
});
