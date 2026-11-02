import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createMachineAdminAccessObserver } from '@/machines/adminAccess/observeMachineAdminAccess';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createCliMachineActionTransport } from '@/session/actions/cliActionDeps/machineTransport';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('admits the held portable Home and refuses a foreign Home through installed reachability ingress', async () => {
    const f = await createInstalledFilesystemMachineFixture();
    // This owner has no optional reachability effect installed. Admission must
    // reach the real executor's capability refusal for its own Home.
    const executor = createActionExecutor({});
    f.machine.setRPCHandlers({ spawnSession: async () => { throw new Error('No Session spawn expected'); },
      stopSession: async () => true, requestShutdown() {} }, { externalActionIngressOwner: {
      currentServerId: f.serverId, executor,
      resolveTarget: async () => ({ kind: 'machine', machineId: f.machineId }),
    } });
    f.machine.registerMachineReachabilityRoutes({
      target: () => ({ serverId: f.serverId, machineId: f.machineId,
        installationId: f.installation.installationId, custodianAccountId: 'requester' }),
      agentIsolation: { read: () => undefined },
      adminAccess: { observer: createMachineAdminAccessObserver({ onChanged: async () => {} }) },
      getMachineClient: () => f.machine,
    });
    const method = getActionSpec('machines.reachability.inspect').bindings?.rpcMethod;
    if (!method) throw new Error('Missing installed Action RPC');
    const invoke = (serverId: string) => f.invoke(method, { serverId, machineId: f.machineId });
    const admitted = await invoke(f.homeServerIdentityId);
    expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    await expect(invoke('srv_foreign_home')).resolves.toMatchObject({ ok: false,
      errorCode: 'admission_unavailable' });
});

it('routes the held portable Home without a saved descriptor and refuses another Home', async () => {
  const f = await createInstalledFilesystemMachineFixture();
  const transport = createCliMachineActionTransport({ serverId: f.serverId,
    serverIdentityId: f.homeServerIdentityId, serverHttpBaseUrl: f.serverHttpBaseUrl,
    machineActionDirectTargetTransport: { machineId: f.machineId,
      invoke: (method, input) => f.rpcHandlerManager.invokeLocal(method, input) },
  });
  await expect(transport.isMachineActionServerScopeCurrent({ serverId: f.serverId })).resolves.toBe(true);
  await expect(createCliMachineActionTransport({ serverId: f.serverId })
    .isMachineActionServerScopeCurrent({ serverId: f.serverId })).resolves.toBe(true);
  await expect(transport.isMachineActionServerScopeCurrent({ serverId: f.homeServerIdentityId })).resolves.toBe(true);
  await expect(transport.isMachineActionServerScopeCurrent({ serverId: 'srv_foreign_home' })).resolves.toBe(false);
  const replay = { serverId: 'creator-profile', machineId: f.machineId, context: {
    serverId: 'creator-profile', serverIdentityId: f.homeServerIdentityId,
    executionRunTargetMachineId: f.machineId, bypassApprovals: true,
  } };
  await expect(transport.isMachineActionServerScopeCurrent(replay)).resolves.toBe(true);
  await expect(transport.isMachineActionServerScopeCurrent({ ...replay,
    context: { ...replay.context, serverIdentityId: 'srv_foreign_home' } })).resolves.toBe(false);
  await expect(transport.isMachineActionServerScopeCurrent({ ...replay,
    context: { ...replay.context, bypassApprovals: false } })).resolves.toBe(false);
});

it('uses the held Home binding for admitted native filesystem effects without re-reading an origin', async () => {
  const f = await createInstalledFilesystemMachineFixture();
  const executor = createActionExecutor(createCliActionDeps({ token: f.bootstrap.credentials.token,
    credentials: f.bootstrap.credentials, serverId: f.serverId, serverIdentityId: f.homeServerIdentityId,
    serverHttpBaseUrl: f.serverHttpBaseUrl, sessionId: '', mode: 'plain', ctx: null }));
  f.machine.setRPCHandlers({ spawnSession: async () => { throw new Error('No Session spawn expected'); },
    stopSession: async () => true, requestShutdown() {} }, { externalActionIngressOwner: {
    currentServerId: f.serverId, executor, resolveTarget: async () => ({ kind: 'machine', machineId: f.machineId }),
  } });
  const execute = (serverId: string, path: string) => f.machine.createFilesystemActionExecutor(f.serverId)({
    actionId: 'daemon.filesystem.createDirectory', input: { rootPath: f.directory, path },
    context: { surface: 'rpc', authority: 'present_user', serverId, runtimeAccountId: 'requester',
      externalActionTarget: { kind: 'machine', machineId: f.machineId },
      machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: f.machineId,
        installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: () => f.bootstrap.isCurrent(),
    },
  });
  const admitted = await execute(f.homeServerIdentityId, 'owner');
  expect(admitted, JSON.stringify(admitted)).toMatchObject({ success: true });
  await expect(access(join(f.directory, 'owner'))).resolves.toBeUndefined();
  await expect(execute('srv_foreign_home', 'foreign')).resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
  await expect(access(join(f.directory, 'foreign'))).rejects.toMatchObject({ code: 'ENOENT' });
});
