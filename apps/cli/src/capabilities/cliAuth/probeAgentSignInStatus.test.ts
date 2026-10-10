import { afterEach, describe, expect, it, vi } from 'vitest';
import { delimiter, join } from 'node:path';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { registerMachineAgentSignInRpcHandlers } from '@/api/machine/rpcHandlers.agentSignIn';
import type { RpcHandler } from '@/api/rpc/types';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

describe('on-demand native sign-in status', () => {
  const directories: string[] = [];
  const probeAgentSignInStatus = async (agentId: string) => {
    const handlers = new Map<string, RpcHandler>();
    registerMachineAgentSignInRpcHandlers({ rpcHandlerManager: {
      registerHandler: (method, handler) => { handlers.set(method, handler); },
    } });
    const handler = handlers.get('daemon.agents.signIn.status');
    expect(handler, 'the native on-demand status operation must be registered').toBeTypeOf('function');
    return await handler!({ agentId });
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
      write('{}');
      expect(await probeAgentSignInStatus('cursor')).toMatchObject({ status: 'signedOut' });
      write('not-json');
      expect(await probeAgentSignInStatus('cursor')).toMatchObject({ status: 'unknown' });
    } finally {
      await runtime.dispose();
    }
  });
  it('does not infer signed-in or signed-out when no native probe can answer', async () => {
    expect(await probeAgentSignInStatus('missing-fixture-agent')).toMatchObject({ status: 'unknown' });
  });
  it('prefers a declared connected service and refuses unsupported native or undeclared service login', async () => {
    const handlers = new Map<string, RpcHandler>();
    registerMachineAgentSignInRpcHandlers({ rpcHandlerManager: {
      registerHandler: (method, handler) => { handlers.set(method, handler); },
    } });
    const prepare = handlers.get('daemon.agents.signIn.prepare');
    expect(prepare).toBeTypeOf('function');
    expect(await prepare!({ agentId: 'gemini' })).toMatchObject({ method: 'connected', command: {
      operation: 'beginConnect', service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' }, modeId: 'api-key',
    } });
    expect(await prepare!({ agentId: 'gemini', method: 'native' })).toMatchObject({ ok: false, errorCode: 'agent_login_unsupported' });
    expect(await prepare!({ agentId: 'gemini', method: 'connected', serviceId: 'not-declared' })).toMatchObject({ ok: false, errorCode: 'connected_service_unsupported' });
  });
});
