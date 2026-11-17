import { createNativeFilesystemMemberFixture, resetNativeFilesystemMemberBoundary } from '@/api/machine/filesystemMemberReceiver.testkit';
import { expect, it, onTestFinished, vi } from 'vitest';
import { ApiMachineClient } from '@/api/apiMachine';
import * as machineSocketTransport from '@/api/machine/connection/createMachineSocketTransport';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { MachineAgentIsolationPreviewResultV1Schema, MachineAgentIsolationStatusV1Schema, type MachineAgentIsolationStatusV1, type MachineAdminAccessV1 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { createAgentIsolationEffectsBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { readAgentIsolationMemberLaunchIdentity, writeAgentIsolationMemberBinding } from '@/daemon/agentIsolation/memberBindings';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { createMachineSetupNativeBackend } from '@happier-dev/cli-common/machineSetup';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

it.skipIf(process.platform !== 'linux').each(['machines.agentIsolation.status', 'machines.agentIsolation.preview', 'machines.agentIsolation.set'] as const)(
  'returns the qualified member result through the declared %s Action output', async actionId => {
    resetNativeFilesystemMemberBoundary();
    onTestFinished(resetNativeFilesystemMemberBoundary);
    const native = await createNativeFilesystemMemberFixture({ accountId: 'requester' });
    const preparation = native.preparation;
    if (!preparation) throw new Error('Expected native isolation preparation fixture');
    const target = { serverId: native.serverId, machineId: native.machineId,
      installationId: native.installation.installationId, custodianAccountId: 'requester' };
    const policy = { enabled: true, memberProvisioning: 'linuxUsersV1' as const };
    const status = { kind: 'effective' as const, platform: 'linux' as const, agentUser: 'happier-agent' as const };
    const setup = createAgentIsolationEffectsBoundary({ installationId: target.installationId,
      installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
      publishStatus: async () => {}, backend: {
        // The Machine's base setup already exists. Member user observation
        // retains the native fixture's UID/GID/home facts for the real inspector.
        observe: async (step, ...rest) => step.kind === 'user' && step.username === native.identity.username
          ? preparation.effects.backend!.observe(step, ...rest)
          : { stepId: step.id, status: 'satisfied', facts: {} },
        apply: async () => { throw new Error('Existing native isolation must not be applied again'); },
      } });
    const socket = createApiSessionSocketStub();
    vi.spyOn(machineSocketTransport, 'createMachineSocketTransport').mockReturnValue({
      // The shared socket stub substitutes the genuine Home network boundary.
      socket: socket as unknown as ReturnType<typeof machineSocketTransport.createMachineSocketTransport>['socket'],
      transport: createSocketTransportAdapter(socket),
    });
    const machine = new ApiMachineClient(native.bootstrap.credentials.token, { id: target.machineId,
      encryptionMode: 'plain', metadata: { host: 'output-host', platform: 'linux', happyCliVersion: 'test',
        homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier', agentIsolation: policy }, metadataVersion: 10,
      daemonState: { status: 'running', runtimeId: 'qualified-output-runtime', agentIsolation: status }, daemonStateVersion: 0 },
      { runtimeId: 'qualified-output-runtime' }, { resolveCurrentServerIdentityId: () => native.homeServerIdentityId });
    onTestFinished(() => machine.shutdown());
    // Use the real own-status inspector, retained member binding and readiness
    // frame. The native fixture supplies only OS identity/permission observations.
    machine.registerMachineAgentIsolationRoutes({ ...setup.effects,
      nativeReadiness: preparation.effects.nativeReadiness });
    machine.connect();
    await vi.waitFor(() => expect(socket.connected).toBe(true));
    const manager: unknown = Reflect.get(machine, 'rpcHandlerManager');
    if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing Machine RPC receiver');
    const rpcContext = { signal: new AbortController().signal, callerAuthority: 'present_user' as const,
      verifyMachineAdmissionCurrent: async () => true, transportRequestId: `qualified-${actionId}`,
      machineAdmission: { actorAccountId: target.custodianAccountId, custodianAccountId: target.custodianAccountId,
        machineId: target.machineId, installationId: target.installationId, role: 'manage' as const, encryptionMode: 'plain' as const } };
    const reviewed = await manager.invokeLocal('machines.agentIsolation.preview', { machineId: target.machineId, ...policy }, { rpcContext });
    if (!reviewed || typeof reviewed !== 'object' || !('plan' in reviewed) || !reviewed.plan || typeof reviewed.plan !== 'object'
      || !('planDigest' in reviewed.plan)) throw new Error('Native isolation preview unavailable');
    if (actionId === 'machines.agentIsolation.preview') {
      const declared = getActionSpec(actionId).outputSchema!.safeParse(reviewed);
      expect(declared.success, JSON.stringify(declared)).toBe(true);
    }
    const executor = createActionExecutor({ machineAgentIsolationAction: async ({ actionId, input }) =>
      manager.invokeLocal(actionId, input, { rpcContext }) } as ActionExecutorDeps);
    const result = await executor.execute(actionId, { machineId: target.machineId,
      ...(actionId === 'machines.agentIsolation.status' ? {} : policy),
      ...(actionId === 'machines.agentIsolation.set' ? { expectedMetadataVersion: 10, expectedPolicy: policy,
        expectedPlanDigest: reviewed.plan.planDigest } : {}) }, { surface: 'ui', serverId: target.serverId,
          // Approval policy is waived for this output-contract test; the real
          // Machine receiver still consumes the admitted Manage boundary above.
          bypassApprovals: true });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: { kind: 'effective', platform: 'linux' } } });
    if (!result.ok) throw new Error(result.errorCode);
    expect(getActionSpec(actionId).outputSchema!.safeParse(result.result).success).toBe(true);
    expect(result.result).not.toHaveProperty('status.agentUser');
    if (actionId === 'machines.agentIsolation.status') expect(result.result).toMatchObject({
      protection: 'member_separated', directories: { home: native.identity.home, workspace: native.identity.workspaceRoot } });
    // A person's qualified result is not the daemon's global launch proof.
    expect(MachineAgentIsolationStatusV1Schema.safeParse({ kind: 'effective', platform: 'linux' }).success).toBe(false);
  });

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
  [{ version: 1, mode: 'none' }, 'mode_none', 'allowed'],
  [{ version: 1, mode: 'ask', administratorUsername: 'admin' }, 'not_preauthorized', 'allowed'],
  [{ version: 1, mode: 'preauthorized' }, 'not_preauthorized', 'denied'],
  [{ version: 1, mode: 'preauthorized' }, 'managed_cli_unavailable', 'allowed'],
] satisfies readonly (readonly [MachineAdminAccessV1, string, 'allowed' | 'denied'])[])(
  'preserves the actual setup prerequisite through the preview Action for %j', async (adminAccess, reasonCode, passwordlessSudoToRoot) => {
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
      effects: { ...boundary.effects, backend: undefined, elevation: { ...boundary.effects.elevation, spawn: undefined,
        observe: async () => ({ ...await boundary.effects.elevation.observe(), passwordlessSudoToRoot }) } } });
    const executor = createActionExecutor({ machineAgentIsolationAction: async ({ input }) => manager.handleRequest({
      requestId: 'b0ac79a8-b800-485d-9a4f-cd1e8ef8f490',
      method: `${target.machineId}:machines.agentIsolation.preview`, params: input,
      callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'fixture-owner', custodianAccountId: target.custodianAccountId,
        machineId: target.machineId, installationId: target.installationId, role: 'manage', encryptionMode: 'plain' },
    }) } as ActionExecutorDeps);
    const result = await executor.execute('machines.agentIsolation.preview', { machineId: target.machineId,
      enabled: true, memberProvisioning: 'linuxUsersV1' }, { surface: 'ui', serverId: target.serverId });
    expect(result).toMatchObject({ ok: true, result: { kind: 'unavailable' } });
    if (!result.ok) throw new Error(result.errorCode);
    const preview = MachineAgentIsolationPreviewResultV1Schema.parse(result.result);
    expect(preview).toMatchObject({ setup: { outcome: 'not_applied', reasonCode } });
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

it.skipIf(process.platform !== 'linux')('Repair reports the missing native user of a retained member binding instead of shared effectiveness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'member-repair-'));
  const target = { serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
  const requesterIdentity = { kind: 'isolated' as const, separationRequired: false, homeServerIdentityId: 'home',
    requester: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' } };
  const policy = { enabled: true, memberProvisioning: 'linuxUsersV1' as const };
  const status = { kind: 'effective' as const, platform: 'linux' as const, agentUser: 'happier-agent' as const };
  // Root-owned account lookup is the OS boundary. The retained binding, native
  // qualification, reviewed Repair and Action operation all remain real.
  const backend = createMachineSetupNativeBackend({ run: async () => ({ code: 2, stdout: '', stderr: '' }) });
  const native = createAgentIsolationEffectsBoundary({ installationId: target.installationId,
    installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
    publishStatus: async () => {}, backend: {
      observe: async step => ({ stepId: step.id, status: 'satisfied', facts: {} }),
      apply: async () => { throw new Error('Shared setup is already satisfied'); },
    } });
  const manager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine',
    encryptionMode: 'plain', logger() {}, authorizeRequest: async () => ({ ok: true }) });
  const { createHostActionOperationRuntime } = await import('@/daemon/actionOperations');
  registerDaemonMachineAgentIsolationRpcHandlers(manager, { target: () => target,
    readCanonicalHomeServerIdentityId: () => 'home', read: () => ({ ...policy, status }), effects: native.effects,
    runActionOperation: createHostActionOperationRuntime({ serverId: 'home', machineId: 'machine', resolveAccountId: async () => 'owner' }).runActionOperation,
    captureMetadataPort: () => ({ read: async () => ({ status: 'ready', metadata: { agentIsolation: policy }, metadataVersion: 10 }),
      compareAndSwap: async () => { throw new Error('Repair must preserve the selected policy'); } }),
    inspectOwn: async ({ requesterIdentity }) => {
      try {
        await readAgentIsolationMemberLaunchIdentity({ requesterIdentity: { ...requesterIdentity,
          homeServerIdentityId: requesterIdentity.requester.serverId }, activeServerDir: directory }, backend);
        throw new Error('Missing native user must not qualify');
      } catch (error) {
        if (!isPluginError(error) || error.code !== 'agent_isolation_unavailable') throw error;
        return { protection: 'unavailable', status: { kind: 'unavailable', code: 'agent_user_missing' } };
      }
    },
  });
  try {
    await writeAgentIsolationMemberBinding(directory, { ...deriveAgentIsolationMemberIdentity(requesterIdentity), agentUid: 2401, agentGid: 2401 });
    const rpcContext = { signal: new AbortController().signal, callerAuthority: 'present_user' as const,
      verifyMachineAdmissionCurrent: async () => true, transportRequestId: 'retained-member-repair',
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const } };
    const reviewed = MachineAgentIsolationPreviewResultV1Schema.parse(await manager.invokeLocal('machines.agentIsolation.preview',
      { machineId: 'machine', ...policy }, { rpcContext }));
    if (reviewed.kind !== 'ready') throw new Error('Shared setup review unavailable');
    expect(reviewed.status).toMatchObject({ kind: 'unavailable', code: 'agent_user_missing' });
    expect(await manager.invokeLocal('machines.agentIsolation.set', { machineId: 'machine', ...policy,
      expectedMetadataVersion: reviewed.metadataVersion, expectedPolicy: reviewed.policy, expectedPlanDigest: reviewed.plan.planDigest },
    { rpcContext })).toMatchObject({ status: { kind: 'unavailable', code: 'agent_user_missing' } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
