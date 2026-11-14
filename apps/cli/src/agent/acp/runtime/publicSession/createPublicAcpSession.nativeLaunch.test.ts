import { readHostedSessionScope, runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { expect, it, vi } from 'vitest';

import type { AgentAcpRuntimeOptions, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createStablePluginExecService, issueAgentNativeLaunchQualifierForHost, type HostProjectNativeLaunchAdmission } from '@/plugins/runtime/invocation/services/exec';
import { handOverSessionHolderClients, SESSION_HOLDER_ADOPT_ENV_KEY } from '@/subprocess/supervision/sessionHolder';
import { waitForCondition } from '@/testkit/async/waitFor';
import { resolveAcpTransportLaunch } from '@/agent/acp/runtime/launch/acpTransportLaunch';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

const runAsBoundary = vi.hoisted(() => ({ script: '' }));
// The runner's report of its held primary Agent to the daemon (a control-API boundary).
const heldAgentReports = vi.hoisted(() => [] as Array<Readonly<{ heldAgentsV1: ReadonlyArray<Readonly<{ socketPath: string; holderPid: number; agentPid: number }>> }>>);
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  notifyDaemonSessionHolder: async (body: (typeof heldAgentReports)[number]) => { heldAgentReports.push(body); },
}));
// The OS substitute receives the real launch frame and ACP stream, without
// simulating sudo's UID switch or filesystem permission enforcement.
// The Agent starts inside the real Session holder; only the holder's final
// `sudo …` argv (the OS RunAs boundary) is substituted on its command line.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const [command, argv, options] = args as unknown as [string, readonly string[] | undefined, Parameters<typeof actual.spawn>[2]];
    const separator = argv?.indexOf('--') ?? -1;
    if (!argv || separator < 0 || argv[0] !== 'serve' || argv[separator + 1] !== 'sudo'
      || !argv.includes('/fixture/happier-private-cwd')) return Reflect.apply(actual.spawn, undefined, args);
    return actual.spawn(command, [...argv.slice(0, separator + 1), process.execPath, runAsBoundary.script], options);
  } };
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
    const configRoot = join(dir, 'session-config');
    await mkdir(join(configRoot, 'fixture'), { recursive: true });
    await writeFile(join(configRoot, 'fixture', 'mcp.json'), JSON.stringify({ scope: source, mcpServers: {} }));
    const capture = join(dir, 'launch.json');
    const script = writeAcpTestAgentScript({ dir, fileName: 'agent.mjs', source: `
      import { createInterface } from 'node:readline';
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const configPath = join(process.env.XDG_CONFIG_HOME ?? process.env.APPDATA ?? '', 'fixture', 'mcp.json');
      writeFileSync(process.env.CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(),
        baseline: process.env.ACP_NATIVE_BASE, configScope: existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')).scope : null,
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
      args: ['authored arg'], env: { AUTHORED_VALUE: 'authored' } },
      definition: { mcp: { policy: 'pass_through', nativeSessionConfig: {
        configRootEnvKey: { posix: 'XDG_CONFIG_HOME', win32: 'APPDATA' },
        homeRelativeConfigRoot: { posix: ['.config'], win32: ['AppData', 'Roaming'] },
        directory: 'fixture', fileName: 'mcp.json', serversKey: 'mcpServers',
      } } } };
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
      const runtime = await runAddedHostedSession({
        environment: { ...process.env, ACP_NATIVE_BASE: source, XDG_CONFIG_HOME: configRoot, APPDATA: configRoot },
        workingDirectory: dir, end() {},
      }, () => createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: dir,
        launchEnvironment: { values: { EXPLICIT: 'launch' }, unset: [] },
        mcpServers: { fixture: { command: '/fixture/mcp' } } }, options, dependencies));
      try {
        expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({ args: ['resolver arg', 'authored arg'], cwd: dir,
          baseline: source, configScope: source, native: 'ready', explicit: 'launch', resolver: 'resolved', authored: 'authored',
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

// `streaming`: the Agent is still answering when the next runner adopts it; `finished`: it
// answered the whole prompt while no runner was attached.
it.each([
  { shape: 'streaming', total: 60, intervalMs: 30 },
  { shape: 'finished', total: 20, intervalMs: 15 },
] as const)('publishes the held Agent output an adopting runner receives after a runner loss, once each ($shape)', async ({ shape, total, intervalMs }) => {
  await withTempDir('happier-acp-adopt-replay-', async dir => {
    const chunkLog = join(dir, 'chunks.log');
    // A create-only ACP Agent: one prompt streams `total` chunks, logging each as it is written.
    const script = writeAcpTestAgentScript({ dir, fileName: 'agent.mjs', source: `
      import { appendFileSync } from 'node:fs';
      import { createInterface } from 'node:readline';
      const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
      for await (const line of createInterface({ input: process.stdin })) {
        const r = JSON.parse(line);
        if (r.id === undefined) continue;
        if (r.method === 'initialize') send({ id: r.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (r.method === 'session/new') send({ id: r.id, result: { sessionId: 'held-session' } });
        else if (r.method === 'session/prompt') {
          let n = 0;
          const timer = setInterval(() => {
            n += 1;
            send({ method: 'session/update', params: { sessionId: 'held-session',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'c' + n + '|' } } } });
            appendFileSync(${JSON.stringify(chunkLog)}, n + '\\n');
            if (n === ${total}) { clearInterval(timer); send({ id: r.id, result: { stopReason: 'end_turn' } }); }
          }, ${intervalMs});
        } else send({ id: r.id, result: {} });
      }
    ` });
    const readProduced = () => existsSync(chunkLog) ? readFileSync(chunkLog, 'utf8').trim().split('\n').length : 0;
    const chunksOf = (events: readonly AgentSessionRuntimeEvent[]) => events
      .flatMap(event => event.kind === 'message-delta' ? [...event.text.matchAll(/c(\d+)\|/g)].map(match => Number(match[1])) : []);
    const openRunner = async (environment: NodeJS.ProcessEnv, request: Parameters<typeof createPublicAcpSession>[0]) => {
      const signal = new AbortController().signal;
      const exec = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
        prepareAgentNativeLaunch: async () => undefined,
        resolveExecutable: async () => { throw new Error('Resolved launch only'); }, resolvePath: async () => dir });
      const events: AgentSessionRuntimeEvent[] = [];
      const runtime = await runAddedHostedSession({ environment, workingDirectory: dir, end() {} }, async () => {
        readHostedSessionScope()!.sessionId = 'session';
        return await createPublicAcpSession(request, { transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } } }, {
          pluginId: 'fixture', agentId: 'fixture', signal, isCurrent: () => true, exec,
          nativeLaunch: issueAgentNativeLaunchQualifierForHost(exec, undefined, undefined, undefined, 'primary'),
          resolveHostLaunch: () => ({ command: process.execPath, args: [script], env: {}, unsetEnv: [], timeouts: {}, release() {} }),
          systemTools: { resolve: async () => { throw new Error('Resolved launch only'); } },
          interactions: { async request() { throw new Error('Unexpected interaction'); } },
          media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
          models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
        });
      });
      runtime.watch(event => { events.push(event as AgentSessionRuntimeEvent); });
      return { runtime, events };
    };
    heldAgentReports.length = 0;
    const started: number[] = [];
    try {
      // Runner 1 starts the turn, publishes a few chunks, then loses its holder connection.
      const first = await openRunner({ ...process.env }, { kind: 'create', sessionId: 'session', cwd: dir });
      await waitForCondition(() => heldAgentReports.length > 0, { timeoutMs: 10_000, intervalMs: 10, label: 'held Agent report' });
      const held = heldAgentReports.at(-1)?.heldAgentsV1[0];
      if (!held) throw new Error('The primary Agent was not reported as held');
      started.push(held.holderPid, held.agentPid);
      expect(await first.runtime.send({ inputIds: ['input'], input: { text: 'stream' },
        delivery: { kind: 'newTurn', turnId: 'turn-1' } })).toEqual({ status: 'admitted' });
      await waitForCondition(() => chunksOf(first.events).length >= 5, { timeoutMs: 10_000, intervalMs: 10, label: 'runner 1 output' });
      await handOverSessionHolderClients();
      const producedAtLoss = readProduced();
      // The Agent keeps answering while no runner is attached.
      await waitForCondition(() => readProduced() >= (shape === 'finished' ? total : producedAtLoss + 8),
        { timeoutMs: 10_000, intervalMs: 10, label: 'held output' });
      if (shape === 'streaming') expect(readProduced()).toBeLessThan(total);

      // Runner 2 adopts the held Agent through the daemon's hand-off token.
      const second = await openRunner({ ...process.env, [SESSION_HOLDER_ADOPT_ENV_KEY]: JSON.stringify({ ...held, turnId: 'turn-1' }) },
        { kind: 'resume', sessionId: 'session', providerSessionId: 'held-session', cwd: dir });
      try {
        await waitForCondition(() => second.events.some(event => event.kind === 'turn-complete'), { timeoutMs: 15_000, intervalMs: 10,
          label: 'adopted turn complete', debug: () => JSON.stringify({ kinds: second.events.map(event => event.kind), produced: readProduced() }) });
        // Runner 1 publishes what it received before the hand-over (acknowledged, so never replayed).
        const all = [...chunksOf(first.events), ...chunksOf(second.events)];
        // Every chunk the Agent produced is published exactly once across the two runners.
        expect({ missing: Array.from({ length: total }, (_, index) => index + 1).filter(n => !all.includes(n)).length,
          repeated: all.length - new Set(all).size, published: all.length })
          .toEqual({ missing: 0, repeated: 0, published: total });
        expect(readProduced()).toBe(total);
      } finally { await second.runtime.dispose(); }
    } finally {
      for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  });
}, 60_000);
