import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionExecutionResultV1Schema, projectExternalActionExecutionResultV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { handleActionsCommand } from '@/cli/commands/actions';
import { registerMachineSessionGoalRpcHandlers } from '@/api/machine/rpcHandlers.sessionGoals';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { requestDaemonSignedRootActionExecution } from '@/daemon/controlClient';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import * as persistence from '@/persistence';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildTestCodexRuntimeDescriptorV1 } from '@/testkit/runtimeDescriptorFixtures';
import { createCliActionDeps } from './createCliActionDeps';

// Only Home/socket I/O and repository build preparation are substituted. The
// CLI entry, Action, daemon registration, router, runtime activation and native
// Goal control remain real. No native process is needed before a thread exists.
vi.mock('@/api/session/sockets', () => ({
  createUserScopedSocketConnection: () => {
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async event => {
      if (event !== SOCKET_RPC_EVENTS.CALL) throw new Error('Unexpected socket event');
      return { ok: true, result: { ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE', error: 'RPC method not available' } };
    } });
    return { socket, transport: { connect: async () => {}, destroy: async () => {}, onDisconnected: () => () => {} } };
  },
}));
vi.mock('@/subprocess/sourceDevSharedDepsPreflight', async importOriginal => ({
  ...await importOriginal<typeof import('@/subprocess/sourceDevSharedDepsPreflight')>(),
  prepareSourceDevSharedDepsForBundledPluginRuntimeLoad: async () => ({
    type: 'ready' as const, checked: false, reason: 'not-source-dev' as const,
  }),
}));

describe('normal CLI early native Goal failure', () => {
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

  it('preserves the native phase through the target daemon and detects missing registration', async () => {
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    let app: ReturnType<typeof createDaemonControlApp> | undefined;
    try {
      const sessionId = 'c123456789012345678901234';
      const credentials = { token: 'goal-token', encryption: null };
      const rawSession = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: true,
        machineId: 'goal-machine', metadata: JSON.stringify({ machineId: 'goal-machine', path: '/repo',
          agentRuntimeDescriptorV1: buildTestCodexRuntimeDescriptorV1({ backendMode: 'appServer' }) }) });
      vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
      vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true, machineId: 'goal-machine' });
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        if (String(url).includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: rawSession } };
        throw new Error(`Unexpected HTTP boundary: ${new URL(String(url)).pathname}`);
      });
      const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
      registerMachineSessionGoalRpcHandlers({ rpcHandlerManager: {
        registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
          handlers.set(method, async raw => handler(raw as TRequest));
        },
      } satisfies RpcHandlerRegistrar, deps: { currentMachineId: 'goal-machine',
        stageWorkStateMutation: async () => { throw new Error('A missing native thread must not publish work state'); } } });
      const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
        serverId: 'goal-server', serverHttpBaseUrl: 'http://goal-home.test',
        machineActionDirectTargetTransport: { machineId: 'goal-machine', invoke: async (method, request) => {
          const handler = handlers.get(method);
          return handler ? await handler(request) : { ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE', error: 'RPC method not available' };
        } } });
      const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"session.goal.get": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps });
      const action = await executor.execute('session.goal.get', { sessionId }, { surface: 'cli' });
      const external = ExternalActionExecutionResultV1Schema.parse(projectExternalActionExecutionResultV1(action));
      expect(external).toMatchObject({ ok: false, errorCode: 'codex_goal_thread_unavailable',
        goalControlFailure: { phase: 'native_effect' } });
      app = createDaemonControlApp({ getChildren: () => [], machineId: 'goal-machine', controlToken: 'goal-control',
        stopSession: async () => { throw new Error('Unexpected process stop'); },
        spawnSession: async () => { throw new Error('Unexpected process spawn'); },
        requestShutdown: () => { throw new Error('Unexpected process shutdown'); }, onHappySessionWebhook: () => {},
        externalActionApi: { currentServerId: 'goal-server', executor,
          verifyPat: async () => { throw new Error('Signed root does not use PAT verification'); },
          resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
        },
      });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Missing daemon HTTP address');
      const produced = await app.inject({ method: 'POST', url: '/actions/root/execute',
        headers: { 'x-happier-daemon-token': 'goal-control' },
        payload: { actionId: 'session.goal.get', input: { sessionId }, target: { kind: 'machine', machineId: 'goal-machine' } },
      });
      expect(ExternalActionExecutionResultV1Schema.parse(produced.json())).toEqual(external);
      const cliExecutor = { ...executor,
        resolveSessionTarget: async (id: string) => ({ ok: true as const, sessionId: id }),
        execute: async (...[actionId, input, context]: Parameters<typeof executor.execute>) =>
          requestDaemonSignedRootActionExecution({ actionId: SignedRootActionIdSchema.parse(actionId), input,
            ...(context?.externalActionTarget ? { target: context.externalActionTarget } : {}),
            ...(context?.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
          }, { target: { pid: process.pid, httpPort: address.port, controlToken: 'goal-control' } }),
      };
      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
        output += String(chunk);
        const callback = args.find(argument => typeof argument === 'function');
        if (typeof callback === 'function') callback();
        return true;
      });
      const invoke = () => handleActionsCommand(['invoke', 'session.goal.get', '--machine-id', 'goal-machine',
        '--project-directory', '/repo', '--input-json', JSON.stringify({ sessionId }), '--json'], {
        readCredentialsFn: async () => credentials,
        createExecutorFn: () => cliExecutor,
      });
      await invoke();
      expect(JSON.parse(output)).toMatchObject({ v: 1, ok: false, kind: 'actions_invoke', error: {
        code: 'codex_goal_thread_unavailable', goalControlFailure: { phase: 'native_effect' },
      } });
      expect(process.exitCode).toBe(1);
      // Removing the actual registered target handler must fail at transport,
      // rather than manufacture native evidence from the earlier invocation.
      handlers.delete(RPC_METHODS.DAEMON_SESSION_GOAL_GET);
      const miswired = await executor.execute('session.goal.get', { sessionId }, { surface: 'cli' });
      expect(miswired).toMatchObject({ ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE' });
      expect(miswired).not.toHaveProperty('goalControlFailure');
      output = '';
      await invoke();
      expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'RPC_METHOD_NOT_AVAILABLE' } });
      expect(JSON.parse(output).error).not.toHaveProperty('goalControlFailure');
    } finally {
      await app?.close();
      await runtime.dispose();
    }
  });
});
