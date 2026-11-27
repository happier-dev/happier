import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { registerDaemonLocalServicesMachineRpcHandlers } from '@/rpc/handlers/daemonLocalServices';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Replace only the loopback listener. The fixture supplies Home HTTP; startup,
// credential selection, Machine admission and Action response projection are real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));
afterEach(() => { vi.restoreAllMocks(); boundary.control = null; });
afterAll(() => pluginReloadController.shutdown());

it('carries the receiving Services credential refusal through the launcher RPC response', async () => {
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain',
    logger: () => {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
      machineId: 'machine', resolveCustodianAccountId: async () => 'custodian',
      resolveInstallationId: () => 'installation', verifyMachineAdmission: async () => true,
    }) });
  await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    onLocalServicesRoutesReady: routes => registerDaemonLocalServicesMachineRpcHandlers(rpc, routes),
  });
  const result = await rpc.handleRequest({ method: `machine:${RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START}`,
    params: createTargetedActionRpcRequestV1({ machineId: 'machine', targetId: 'declared-worker' },
      { kind: 'machine', machineId: 'machine' }),
    machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'custodian', machineId: 'machine',
      installationId: 'installation', role: 'use', encryptionMode: 'plain' },
  });
  expect(ActionExecuteFailureSchema.parse(result)).toMatchObject({ ok: false, errorCode: 'custodian_only',
    failureCause: { phase: 'local_services.credential_selection', errorCode: 'custodian_only' } });
});
