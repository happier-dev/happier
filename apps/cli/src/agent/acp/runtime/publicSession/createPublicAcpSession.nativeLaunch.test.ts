import { existsSync, readFileSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { expect, it, vi } from 'vitest';

import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agents/runtime';
import { createStablePluginExecService, type HostProjectNativeLaunchAdmission } from '@/plugins/runtime/invocation/services/exec';
import { resolveAcpTransportLaunch } from '@/agent/acp/runtime/launch/acpTransportLaunch';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

const runAsBoundary = vi.hoisted(() => ({ script: '' }));
// The OS substitute receives the real launch frame and ACP stream, without
// simulating sudo's UID switch or filesystem permission enforcement.
vi.mock('cross-spawn', async importOriginal => {
  const actual = await importOriginal<typeof import('cross-spawn')>();
  return { ...actual, default: Object.assign((...args: Parameters<typeof actual.default>) => {
    if (args[0] !== 'sudo' || !args[1]?.includes('/fixture/happier-private-cwd')) return actual.default(...args);
    return actual.default(process.execPath, [runAsBoundary.script], args[2]);
  }, actual.default) };
});

it.skipIf(process.platform !== 'linux')('retains the logical ACP cwd while spawning RunAs from the authorized outer cwd', async () => {
  await withTempDir('happier-acp-private-cwd-', async dir => {
    const home = join(dir, 'member-home');
    await mkdir(home, { mode: 0o700 });
    const cwd = await realpath(home);
    const capture = join(dir, 'launch.json');
    runAsBoundary.script = writeAcpTestAgentScript({ dir, fileName: 'runas.mjs', source: `
      import { writeFileSync } from 'node:fs';
      let pending = Buffer.alloc(0), frame, lines = '';
      for await (const chunk of process.stdin) {
        pending = Buffer.concat([pending, chunk]);
        if (!frame) {
          if (pending.length < 12) continue;
          const length = 12 + pending.readUInt32BE(8);
          if (pending.length < length) continue;
          frame = pending.subarray(0, length).toString('base64');
          pending = pending.subarray(length);
        }
        lines += pending.toString('utf8'); pending = Buffer.alloc(0);
        let newline;
        while ((newline = lines.indexOf('\\n')) !== -1) {
          const r = JSON.parse(lines.slice(0, newline)); lines = lines.slice(newline + 1);
          if (r.id === undefined) continue;
          if (r.method === 'session/new') writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
            cwd: process.cwd(), frame, sessionCwd: r.params.cwd,
          }));
          const result = r.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} }
            : r.method === 'session/new' ? { sessionId: 'private-session' } : {};
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
        }
      }
    ` });
    const signal = new AbortController().signal;
    const memberIdentity = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'home',
      requester: { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } }),
      home: cwd, agentUid: 994, agentGid: 994 };
    const exec = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
      resolveExecutable: async () => { throw new Error('Resolved launch only'); }, resolvePath: async () => cwd,
      prepareAgentNativeLaunch: async () => undefined,
      agentIsolation: { read: () => ({ enabled: true,
        status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
        workspaceRoots: [cwd], memberIdentity, localTransport: { agentUid: 994, agentGid: 994 },
        launch: { managedHappierBinaryPath: '/fixture/happier-private-cwd', runtimeHome: join(cwd, 'runtime'),
          selectedEnvironmentKeys: [], selectedMaterials: [],
          sessionMcpContext: { v: 1, socketPath: join(dir, 'mcp.sock'), bearerToken: 'selected-session' } } }) },
    });
    const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd },
      { transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } } }, {
        pluginId: 'fixture', agentId: 'fixture', signal, isCurrent: () => true, exec,
        resolveHostLaunch: () => ({ command: process.execPath, args: ['--version'], env: {}, unsetEnv: [], timeouts: {}, release() {} }),
        systemTools: { resolve: async () => { throw new Error('Resolved launch only'); } },
        interactions: { async request() { throw new Error('Unexpected interaction'); } },
        media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
        models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
      });
    try {
      const observed = JSON.parse(readFileSync(capture, 'utf8'));
      const frame = await readAgentLaunchFrame(Readable.from([Buffer.from(observed.frame, 'base64')], { objectMode: false }));
      expect(frame).toMatchObject({ cwd, executable: process.execPath, args: ['--version'],
        nativeIdentity: { username: memberIdentity.username, home: cwd, agentUid: 994, agentGid: 994 } });
      expect(observed.sessionCwd).toBe(cwd);
      expect(observed.cwd).toBe(process.cwd());
    } finally { await runtime.dispose(); runAsBoundary.script = ''; }
  });
});

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
      projectLaunch: { status: 'ready', reviewedEffectDigest: 'reviewed-native-launch', toolchain: {
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

it('retains the ACP isolation refusal before opening its transport', async () => {
  const signal = new AbortController().signal;
  const cwd = process.cwd();
  const release = vi.fn();
  const exec = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
    resolveExecutable: async () => { throw new Error('Resolved launch only'); }, resolvePath: async () => cwd,
    prepareAgentNativeLaunch: async () => undefined,
    agentIsolation: { read: () => ({ enabled: true, status: { kind: 'applying', phase: 'runtime_replacement' }, workspaceRoots: [cwd] }) },
  });
  await expect(createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd },
    { transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } } }, {
      pluginId: 'fixture', agentId: 'fixture', signal, isCurrent: () => true, exec,
      resolveHostLaunch: () => ({ command: process.execPath, args: ['--version'], env: {}, unsetEnv: [], timeouts: {}, release }),
      systemTools: { resolve: async () => { throw new Error('Resolved transport only'); } },
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    })).rejects.toMatchObject({ code: 'agent_isolation_unavailable', execLaunch: 'notStarted', retryable: false,
      data: { details: { reason: process.platform === 'linux' ? 'isolation_not_ready' : 'unsupported_platform', launchKind: 'acp' } } });
  expect(release).toHaveBeenCalledOnce();
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
