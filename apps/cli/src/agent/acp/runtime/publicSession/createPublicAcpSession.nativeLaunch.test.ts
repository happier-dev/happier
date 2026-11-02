import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { expect, it, vi } from 'vitest';

import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agents/runtime';
import { createStablePluginExecService, type HostProjectNativeLaunchAdmission } from '@/plugins/runtime/invocation/services/exec';
import { resolveAcpTransportLaunch } from '@/agent/acp/runtime/launch/acpTransportLaunch';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

it.each(['declared', 'account'] as const)('finalizes the complete cold %s ACP launch before the process starts', async source => {
  await withTempDir('happier-acp-native-launch-', async dir => {
    await writeFile(join(dir, 'mise.toml'), '[env]\nNATIVE_VALUE="ready"\n');
    const capture = join(dir, 'launch.json');
    const script = writeAcpTestAgentScript({ dir, fileName: 'agent.mjs', source: `
      import { createInterface } from 'node:readline';
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.env.CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(),
        native: process.env.NATIVE_VALUE, removed: process.env.ACP_NATIVE_REMOVE, lowerCase: process.env.acp_native_remove,
        shellFunction: process.env['BASH_FUNC_acpFixture%%'], explicit: process.env.EXPLICIT,
        resolver: process.env.RESOLVER_VALUE, authored: process.env.AUTHORED_VALUE }));
      for await (const line of createInterface({ input: process.stdin })) {
        const r = JSON.parse(line);
        if (r.id === undefined) continue;
        const result = r.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} }
          : r.method === 'session/new' ? { sessionId: 'native-session' }
          : r.method === 'session/prompt' ? { stopReason: 'end_turn' } : {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
      }
    ` });
    const signal = new AbortController().signal;
    const release = vi.fn();
    let nativeRuns = 0;
    const prepareAgentNativeLaunch = vi.fn(async (): Promise<{ projectLaunch: HostProjectNativeLaunchAdmission }> => ({
      projectLaunch: { status: 'ready', reviewedEffectDigest: 'reviewed-native-launch', environment: {
        selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, platform: 'linux',
        io: { resolveTool: async () => ({ executablePath: '/native/mise', version: '2026.10.4' }),
          run: async request => {
            nativeRuns++;
            expect(request.cwd).toBe(dir);
            expect(request.signal?.aborted).toBe(false);
            const env: Record<string, string> = { ...request.env, NATIVE_VALUE: 'ready' };
            delete env.ACP_NATIVE_REMOVE;
            delete env['BASH_FUNC_acpFixture%%'];
            return { exitCode: 0, stdout: Object.entries(env).map(([key, value]) => `${key}=${value}\0`).join('') };
          } },
      } },
    }));
    const exec = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
      prepareAgentNativeLaunch, resolveExecutable: async () => { throw new Error('Unexpected executable resolution'); },
      resolvePath: async () => dir });
    const systemTools = { resolve: async () => ({ toolId: 'fixture', launch: {
      kind: 'binary', executablePath: process.execPath, args: [script, 'resolver arg'],
      env: { CAPTURE: capture, RESOLVER_VALUE: 'resolved' },
    } }) };
    const dependencies: PublicAcpComposerDependencies = {
      pluginId: 'fixture', agentId: 'fixture', signal, isCurrent: () => true, systemTools, exec,
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
      ...(source === 'account' ? { resolveHostLaunch: () => ({ command: process.execPath,
        args: [script, 'resolver arg', 'authored arg'], env: { CAPTURE: capture, RESOLVER_VALUE: 'resolved', AUTHORED_VALUE: 'authored' },
        unsetEnv: [], timeouts: {}, release }) } : {}),
    };
    const options: AgentAcpRuntimeOptions = { transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' },
      args: ['authored arg'], env: { AUTHORED_VALUE: 'authored' } } };
    vi.stubEnv('ACP_NATIVE_REMOVE', 'ambient');
    if (process.platform !== 'win32') {
      vi.stubEnv('acp_native_remove', 'distinct-posix-value');
      vi.stubEnv('BASH_FUNC_acpFixture%%', '() { :; }');
    }
    try {
      // Auxiliary reads use the shared resolver without acquiring native effects.
      await resolveAcpTransportLaunch({ transport: options.transport, pluginId: 'fixture', purpose: 'session/list',
        systemTools, signal });
      expect(nativeRuns).toBe(0);
      const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: dir,
        launchEnvironment: { values: { EXPLICIT: 'launch' }, unset: [] } }, options, dependencies);
      try {
        expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({ args: ['resolver arg', 'authored arg'], cwd: dir,
          native: 'ready', explicit: 'launch', resolver: 'resolved', authored: 'authored',
          ...(process.platform === 'win32' ? {} : { lowerCase: 'distinct-posix-value' }) });
        expect(await runtime.send({ inputIds: ['input'], input: { text: 'Continue this warm session' },
          delivery: { kind: 'newTurn', turnId: 'turn' } })).toEqual({ status: 'admitted' });
        expect(nativeRuns).toBe(1);
        expect(prepareAgentNativeLaunch).toHaveBeenCalledTimes(1);
      } finally { await runtime.dispose(); }
      expect(release).toHaveBeenCalledTimes(source === 'account' ? 1 : 0);
    } finally { vi.unstubAllEnvs(); }
  });
});

it.each(['child', 'cancel'] as const)('refuses %s before opening the cold ACP process and releases its resolved launch', async failure => {
  await withTempDir('happier-acp-child-refusal-', async dir => {
    const capture = join(dir, 'spawned');
    const controller = new AbortController();
    const signal = controller.signal;
    const release = vi.fn();
    const exec = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
      prepareAgentNativeLaunch: async () => {
        if (failure === 'cancel') {
          controller.abort();
          return undefined;
        }
        return { projectLaunch: { status: 'refused', kind: 'child_required', code: 'project_child_required' } };
      },
      resolveExecutable: async () => { throw new Error('Unexpected executable resolution'); }, resolvePath: async () => dir });
    const dependencies: PublicAcpComposerDependencies = {
      pluginId: 'fixture', agentId: 'fixture', signal, isCurrent: () => true, exec,
      systemTools: { resolve: async () => { throw new Error('Unexpected system tool'); } },
      resolveHostLaunch: () => ({ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(capture)}, 'spawned')`],
        env: {}, unsetEnv: [], timeouts: {}, release }),
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    };
    await expect(createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: dir },
      { transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } } }, dependencies))
      .rejects.toMatchObject({ code: failure === 'child' ? 'project_child_required' : 'plugin_exec_aborted' });
    expect(existsSync(capture)).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

it('opens a remote ACP transport without preparing a local native launch', async () => {
  const server = createServer(socket => {
    void (async () => {
      for await (const line of createInterface({ input: socket })) {
        const request = JSON.parse(line);
        if (request.id === undefined) continue;
        const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} }
          : request.method === 'session/new' ? { sessionId: 'remote-session' } : {};
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
      }
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    const signal = new AbortController().signal;
    const prepareAgentNativeLaunch = vi.fn(async () => { throw new Error('Remote transport must stay passive'); });
    const exec = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
      prepareAgentNativeLaunch, resolveExecutable: async () => { throw new Error('Unexpected executable'); }, resolvePath: async () => process.cwd() });
    const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: process.cwd() },
      { transport: { kind: 'tcp', host: '127.0.0.1', port: address.port } }, {
        pluginId: 'fixture', agentId: 'fixture', signal, isCurrent: () => true, exec,
        systemTools: { resolve: async () => { throw new Error('Unexpected system tool'); } },
        interactions: { async request() { throw new Error('Unexpected interaction'); } },
        media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
        models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
      });
    try { expect(prepareAgentNativeLaunch).not.toHaveBeenCalled(); }
    finally { await runtime.dispose(); }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
