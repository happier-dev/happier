import { afterEach, describe, expect, it, vi } from 'vitest';
import { delimiter, join } from 'node:path';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { registerMachineAgentSignInRpcHandlers } from '@/api/machine/rpcHandlers.agentSignIn';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { AgentSignInStatusResponseSchema } from '@happier-dev/protocol/daemon/agentSignIn';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createActionExecutor } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';

describe('on-demand native sign-in status', () => {
  const directories: string[] = [];
  const probeAgentSignInStatus = async (agentId: string, context?: RpcHandlerContext) => {
    const handlers = new Map<string, RpcHandler>();
    registerMachineAgentSignInRpcHandlers({ rpcHandlerManager: {
      registerHandler: (method, handler) => { handlers.set(method, handler); },
    } });
    const handler = handlers.get('daemon.agents.signIn.status');
    expect(handler, 'the native on-demand status operation must be registered').toBeTypeOf('function');
    return AgentSignInStatusResponseSchema.parse(await handler!({ agentId }, context));
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of directories.splice(0)) removeTempDirSync(dir);
  });
  it('reads the native probe each time, including signed-out and unparseable results', async () => {
    const dir = createTempDirSync('agent-sign-in-'); directories.push(dir);
    for (const name of ['HOME', 'USERPROFILE', 'HAPPIER_HOME_DIR']) vi.stubEnv(name, dir);
    vi.stubEnv('CURSOR_API_KEY', undefined);
    const fileName = process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent';
    const write = (output: string) => writeExecutableShimSync({ dir, fileName,
      contents: process.platform === 'win32' ? `@echo off\r\necho ${output}\r\n` : `#!/bin/sh\nprintf '%s\\n' '${output}'\n`,
    });
    vi.stubEnv('HAPPIER_CURSOR_PATH', join(dir, fileName));
    // The manifest's system-tool probe also resolves by executable name.
    vi.stubEnv('PATH', `${dir}${delimiter}${process.env.PATH ?? ''}`);
    write('{"user":{"email":"fixture@example.invalid"}}');
    // The native JSON interpretation belongs to Cursor's admitted cliAuth
    // contribution. The cold declaration projection is not executable authority.
    const runtime = await createAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.cursor'] },
    });
    try {
      expect(await probeAgentSignInStatus('cursor')).toMatchObject({ status: 'signedIn', accountLabel: 'fixture@example.invalid' });
      const admission = { actorAccountId: 'guest', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' } as const;
      const guestContext = { signal: new AbortController().signal, machineAdmission: admission };
      const guest = await probeAgentSignInStatus('cursor', guestContext);
      expect(guest).toMatchObject({ status: 'signedIn', signInScope: 'machineOwner' });
      expect(guest).not.toHaveProperty('accountLabel');
      // Start at the real Action dispatcher, retaining its admitted root across
      // the local Machine transport and native probe rather than supplying a reply.
      const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {} });
      registerMachineAgentSignInRpcHandlers({ rpcHandlerManager: rpc });
      const actionId = 'machines.agents.signIn.status';
      const target = { kind: 'machine' as const, machineId: 'machine' };
      const executor = createActionExecutor(createCliActionDeps({ token: '', sessionId: '', mode: 'plain', ctx: null,
        serverId: 'home', serverHttpBaseUrl: 'http://home.test', serverIdentityId: 'home',
        externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: new Uint8Array(64),
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: (method, input, options) => rpc.invokeLocal(method, input, options) },
      }));
      for (const [actorAccountId, role] of [['guest', 'use'], ['owner', 'manage'], ['manager', 'manage']] as const) {
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-admitted-root', binding: {
          accountId: actorAccountId, custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
          accountEncryptionMode: 'plain', serverIdentityId: 'home', actionId, requestId: 'status-read',
          machineId: 'machine', installationId: 'installation', target, requestEnvelopeDigest: 'a'.repeat(43),
        } });
        const context = { surface: 'cli', authority: 'present_user', serverId: 'home', actionRequestId: 'status-read',
          machineAdmission: { ...admission, actorAccountId, role }, externalActionExecutionAuthorization: authorization,
          externalActionTarget: target } satisfies RpcActionExecutorContext;
        const result = await executor.execute(actionId, { machineId: 'machine', agentId: 'cursor' }, context);
        expect(result).toMatchObject({ ok: true, result: { status: 'signedIn' } });
        if (!result.ok) throw new Error('Status Action failed');
        if (role === 'use') {
          expect(result.result).not.toHaveProperty('accountLabel');
          expect(result.result).toMatchObject({ signInScope: 'machineOwner' });
        } else {
          expect(result.result).toMatchObject({ accountLabel: 'fixture@example.invalid' });
          expect(result.result).not.toHaveProperty('signInScope');
        }
      }
      for (const actorAccountId of ['owner', 'manager']) {
        const full = await probeAgentSignInStatus('cursor', { ...guestContext,
          machineAdmission: { ...admission, actorAccountId, role: 'manage' },
        });
        expect(full).toMatchObject({ status: 'signedIn', accountLabel: 'fixture@example.invalid' });
        expect(full).not.toHaveProperty('signInScope');
      }
      write('{}');
      expect(await probeAgentSignInStatus('cursor')).toMatchObject({ status: 'signedOut' });
      expect(await probeAgentSignInStatus('cursor', guestContext)).toMatchObject({ status: 'signedOut', signInScope: 'machineOwner' });
      write('not-json');
      expect(await probeAgentSignInStatus('cursor')).toMatchObject({ status: 'unknown' });
      expect(await probeAgentSignInStatus('cursor', guestContext)).toMatchObject({ status: 'unknown', signInScope: 'machineOwner' });
    } finally {
      await runtime.dispose();
    }
  });
  it('does not infer signed-in or signed-out when no native probe can answer', async () => {
    expect(await probeAgentSignInStatus('missing-fixture-agent')).toMatchObject({ status: 'unknown' });
  });
  it('prefers an admitted Agent\'s declared connected service and refuses unsupported native or undeclared service login', async () => {
    const handlers = new Map<string, RpcHandler>();
    registerMachineAgentSignInRpcHandlers({ rpcHandlerManager: {
      registerHandler: (method, handler) => { handlers.set(method, handler); },
    } });
    const prepare = handlers.get('daemon.agents.signIn.prepare');
    expect(prepare).toBeTypeOf('function');
    const runtime = await createAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.gemini'] },
    });
    try {
      expect(await prepare!({ agentId: 'gemini' })).toMatchObject({ method: 'connected', command: {
        operation: 'beginConnect', service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' }, modeId: 'api-key',
      } });
      expect(await prepare!({ agentId: 'gemini', method: 'native' })).toMatchObject({ ok: false, errorCode: 'agent_login_unsupported' });
      expect(await prepare!({ agentId: 'gemini', method: 'connected', serviceId: 'not-declared' })).toMatchObject({ ok: false, errorCode: 'connected_service_unsupported' });
    } finally {
      await runtime.dispose();
    }
  });
});
