import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';

import {
  createCodexSharedAppServer,
  readCodexNativeTransportStartupFailure,
  readCodexSharedAppServerStartupFailure,
} from './sharedServer.js';
import { createCodexNativeAppServerClient } from './client';
import { connectManagedJsonRpcTestClient } from '../../../../../../../apps/cli/src/testkit/process/managedJsonRpc';
import { createCodexControlSocketFixture } from './client.test-support';

type AgentNativeLaunchQualifier = NonNullable<NonNullable<Parameters<ExecService['spawn']>[1]>['nativeLaunch']>;

function connectFixtureClient(request: { endpoint: { socketPath: string }; maxFrameBytes?: number; requestTimeoutMs?: number }, options?: { signal?: AbortSignal }) {
  return connectManagedJsonRpcTestClient({ cwd: tmpdir(), socketPath: request.endpoint.socketPath,
    maxFrameBytes: request.maxFrameBytes, requestTimeoutMs: request.requestTimeoutMs, signal: options?.signal });
}

const osBoundary = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, userInfo: () => ({ ...os.userInfo(), homedir: osBoundary.home }) };
});

describe('createCodexSharedAppServer', () => {
  beforeEach(async () => { osBoundary.home = await mkdtemp(join(tmpdir(), 'codex-startup-home-')); });
  afterEach(async () => { await rm(osBoundary.home, { recursive: true, force: true }); });
  it.skipIf(!['darwin', 'linux'].includes(process.platform)).each(['within_limit', 'exceeds_limit'] as const)(
    'retains the actual OS errno and syscall through startup sanitization: %s', async lengthClass => {
      const directory = await mkdtemp('/tmp/codex-connect-failure-');
      try {
        // Multibyte names distinguish the OS's UTF-8 byte capacity from JS length.
        const socketPath = join(directory, lengthClass === 'exceeds_limit' ? `${'é'.repeat(60)}.sock` : 'missing.sock');
        const exec = { systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } }) },
          clients: { connectJsonRpc: connectFixtureClient } } as unknown as ExecService;
        const error: unknown = await createCodexNativeAppServerClient({ exec, processEnv: {},
          transport: { kind: 'unixWebSocket', socketPath, realtimeConversationAdvertised: false },
        }).then(() => { throw new Error('Expected native endpoint refusal'); }, error => error);
        const failure = readCodexNativeTransportStartupFailure(error);
        expect(failure).toEqual({
          phase: 'native_system_error', reason: 'system_error',
          errnoCode: expect.stringMatching(/^(ENOENT|ENAMETOOLONG|EINVAL)$/), syscall: 'connect',
          transport: 'unixWebSocket', socketPathLengthClass: lengthClass,
        });
        expect(readCodexSharedAppServerStartupFailure(failure)).toEqual(failure);
        expect(readCodexSharedAppServerStartupFailure({
          ...failure, transport: 'unixWebSocket', syscall: 'unavailable', socketPathLengthClass: 'PRIVATE_LENGTH_SENTINEL', path: directory,
        })).toEqual({
          phase: 'native_system_error', reason: 'system_error', errnoCode: failure?.errnoCode,
          syscall: 'unavailable', transport: 'unixWebSocket',
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
  });

  it.skipIf(process.platform === 'win32')('retries a real refused managed connection while the native server remains alive', async () => {
    let nativePeer: Awaited<ReturnType<typeof createCodexControlSocketFixture>> | undefined;
    let nativeSpawns = 0;
    let connected = 0;
    const failures: unknown[] = [];
    let finish!: (result: PluginProcessResult) => void;
    const exited = new Promise<PluginProcessResult>(resolve => { finish = resolve; });
    const result: PluginProcessResult = { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
      stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
    const exec = {
      systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } }) },
      run: async () => ({ ...result, stdout: new TextEncoder().encode('codex-cli 0.162.1') }),
      spawn: async (request: Parameters<ExecService['spawn']>[0]) => {
        nativeSpawns += 1;
        const endpoint = request.args![request.args!.indexOf('--listen') + 1]!.slice('unix://'.length);
        await mkdir(dirname(endpoint), { recursive: true });
        // Publish an OS path before accepting connections, as a native bind/listen race can do.
        await writeFile(endpoint, '');
        return { wait: () => exited, dispose: async () => { await nativePeer?.close(); nativePeer = undefined; finish(result); } };
      },
      clients: { connectJsonRpc: async (request: Parameters<typeof connectFixtureClient>[0], options?: { signal?: AbortSignal }) => {
        connected += 1;
        try { return await connectFixtureClient(request, options); }
        catch (error) {
          failures.push(readCodexNativeTransportStartupFailure(error));
          if (failures.length === 1) {
            await rm(request.endpoint.socketPath);
            nativePeer = await createCodexControlSocketFixture(request.endpoint.socketPath, message =>
              message.method === 'initialize' ? {} : message.id === undefined ? undefined : { pong: true });
          }
          throw error;
        }
      } },
    } as unknown as ExecService;
    const server = await createCodexSharedAppServer({ exec, processEnv: {}, platform: 'linux' });
    if (!server) throw new Error('Expected shared native server');
    let client: Awaited<ReturnType<typeof server.createClient>> | undefined;
    try {
      client = await server.createClient({ cwd: osBoundary.home, processEnv: {}, configOverrides: [], disableUserMcpServers: false });
      await expect(client.request('test/ping')).resolves.toEqual({ pong: true });
      expect(failures).toEqual([expect.objectContaining({ errnoCode: 'ECONNREFUSED', syscall: 'connect' })]);
      expect(connected).toBe(2);
      expect(nativeSpawns).toBe(1);
    } finally { await client?.dispose(); await server.dispose(); }
  });

  it.skipIf(process.platform === 'win32')('publishes distinct bindable Unix paths even with a long native home and TMPDIR', async () => {
    const home = osBoundary.home;
    const longHome = join(home, 'long-home-'.repeat(18));
    await mkdir(longHome, { recursive: true });
    osBoundary.home = longHome;
    vi.stubEnv('TMPDIR', longHome);
    const servers: NonNullable<Awaited<ReturnType<typeof createCodexSharedAppServer>>>[] = [];
    const listener = createServer();
    const result: PluginProcessResult = {
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
      stdout: new TextEncoder().encode('codex-cli 0.162.1'), stderr: new Uint8Array(),
      stdoutTruncated: false, stderrTruncated: false,
    };
    // Only the executable/version OS boundary is replaced; directory ownership,
    // endpoint construction, actual OS bind and cleanup use production logic.
    const exec = {
      clients: { connectJsonRpc: connectFixtureClient },
      systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } }) },
      run: async () => result,
    } as unknown as ExecService;
    try {
      for (let index = 0; index < 2; index++) {
        const server = await createCodexSharedAppServer({ exec, processEnv: { CODEX_HOME: longHome } });
        if (!server) throw new Error('Expected Unix shared control');
        servers.push(server);
      }
      expect(servers[0]!.endpoint).not.toBe(servers[1]!.endpoint);
      const socketPath = servers[0]!.endpoint.slice('unix://'.length);
      // Darwin sun_path has 104 bytes including its terminating NUL; Linux has 108.
      expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(process.platform === 'darwin' ? 103 : 107);
      await mkdir(dirname(socketPath), { mode: 0o700 });
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(socketPath, resolve);
      });
      expect(listener.listening).toBe(true);
    } finally {
      if (listener.listening) await new Promise<void>(resolve => listener.close(() => resolve()));
      await Promise.all(servers.map(server => server.dispose()));
      vi.unstubAllEnvs();
      osBoundary.home = home;
    }
  });

  it.skipIf(process.platform === 'win32').each(['ready', 'abort', 'exit'] as const)(
    'observes native startup %s without imposing the RPC budget on backfill', async outcome => {
    const directory = await mkdtemp(join('/tmp', 'codex-backfill-'));
    const http = createServer();
    const sockets = new WebSocketServer({ server: http });
    sockets.on('connection', socket => socket.on('message', data => {
      const message = JSON.parse(String(data)) as { id?: number; method?: string };
      if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: {} }));
    }));
    const nativeResult: PluginProcessResult = {
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'dispose', reason: 'caller' } },
      stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
    };
    let settleExit: ((result: PluginProcessResult) => void) | undefined;
    const exited = new Promise<PluginProcessResult>(resolve => { settleExit = resolve; });
    let clockOffset = 0;
    const realNow = Date.now.bind(Date);
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
    const controller = new AbortController();
    const dispose = vi.fn(async () => {
      for (const socket of sockets.clients) socket.terminate();
      if (http.listening) await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      settleExit?.(nativeResult);
    });
    const exec = {
      clients: { connectJsonRpc: connectFixtureClient },
      systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } }) },
      run: async (request: Parameters<ExecService['run']>[0]) => ({
        ...nativeResult,
        termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode(request.args?.includes('--version') ? 'codex-cli 0.162.1' : ''),
      }),
      spawn: async (request: Parameters<ExecService['spawn']>[0]) => {
        const args = request.args ?? [];
        const socketPath = args[args.indexOf('--listen') + 1]!.slice('unix://'.length);
        await mkdir(dirname(socketPath), { recursive: true });
        setTimeout(() => {
          if (outcome === 'exit') settleExit?.({ ...nativeResult,
            termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } },
          });
          else {
            // Simulate a native history backfill outlasting the RPC budget.
            clockOffset += 120_000;
            if (outcome === 'abort') controller.abort();
            else http.listen(socketPath);
          }
        }, 10);
        return { write: async () => undefined, closeStdin: async () => undefined,
          onOutput: () => ({ dispose: () => undefined }), wait: () => exited, dispose };
      },
    } as unknown as ExecService; // Only the native process boundary is substituted.
    let server: Awaited<ReturnType<typeof createCodexSharedAppServer>> = null;
    try {
        server = await createCodexSharedAppServer({
          exec, processEnv: {}, platform: 'linux', signal: controller.signal,
        });
        if (!server) throw new Error('Expected supported shared control');
        const opening = server.createClient({ cwd: directory, processEnv: {}, configOverrides: [], disableUserMcpServers: false });
        if (outcome === 'abort') {
          await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
          expect(dispose).toHaveBeenCalledTimes(1);
        } else if (outcome === 'exit') {
          await expect(opening).rejects.toMatchObject({ code: 'agent_startup_transport_failed',
            startupFailure: { reason: 'process_exited', nativeExitCode: 1 },
          });
        } else {
          const client = await opening;
          await client.dispose();
        }
    } finally {
      now.mockRestore();
      await server?.dispose();
      sockets.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32').each([
    ['serializes native socket startup until the first real initialize completes', false, false],
    ['keeps failed native socket startup exclusive through process shutdown', true, false],
    ['preserves native initialization failure alongside failed process cleanup', true, true],
  ] as const)('%s', async (_name, firstInitializeFails, firstCleanupFails) => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-shared-startup-'));
    const guard = join(directory, 'native-startup');
    const sqliteHome = join(directory, 'sqlite');
    const processEnv = { CODEX_HOME: join(directory, 'auth'), CODEX_SQLITE_HOME: sqliteHome };
    const nativeStartupLock = join(userInfo().homedir, '.happier-codex-native-startup.lock');
    const cleanupWasExclusive: boolean[] = [];
    let spawnCount = 0;
    let releaseInitialization: () => void = () => undefined;
    const initializationReady = new Promise<void>(resolve => { releaseInitialization = resolve; });
    const nativeLaunch = Object.freeze({}) as AgentNativeLaunchQualifier;
    const spawnOptions: Parameters<ExecService['spawn']>[1][] = [];
    const probeOptions: Parameters<ExecService['run']>[1][] = [];
    const result = (stdout = ''): PluginProcessResult => ({
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
      stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(),
      stdoutTruncated: false, stderrTruncated: false,
    });
    // Exec is the OS/host process boundary. The actual socket and real plugin
    // client perform the handshake; no provider orchestration is replaced.
    const exec = {
      clients: { connectJsonRpc: connectFixtureClient },
      systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } }) },
      run: async (request: Parameters<ExecService['run']>[0], options: Parameters<ExecService['run']>[1]) => {
        probeOptions.push(options);
        return result(request.args?.includes('--version') ? 'codex-cli 0.162.1' : 'realtime_conversation under development false');
      },
      spawn: async (request: Parameters<ExecService['spawn']>[0], options: Parameters<ExecService['spawn']>[1]) => {
        spawnOptions.push(options);
        const shouldFailInitialize = firstInitializeFails && spawnCount++ === 0;
        const startupOwner = readFileSync(nativeStartupLock, 'utf8');
        await mkdir(guard);
        const args = request.args ?? [];
        if (process.platform === 'linux') expect(args).toContain(`sqlite_home=${JSON.stringify(sqliteHome)}`);
        const endpoint = args[args.indexOf('--listen') + 1];
        if (!endpoint?.startsWith('unix://')) throw new Error('Expected native Unix endpoint');
        const socketPath = endpoint.slice('unix://'.length);
        await mkdir(dirname(socketPath), { recursive: true });
        const http = createServer();
        const sockets = new WebSocketServer({ server: http });
        sockets.on('connection', socket => socket.on('message', async data => {
          const message = JSON.parse(String(data)) as { id?: number; method?: string };
          if (message.method === 'initialize') {
            await initializationReady;
            if (shouldFailInitialize) {
              socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: 'fixture initialize failed' } }));
              return;
            }
            await rm(guard, { recursive: true });
            socket.send(JSON.stringify({ id: message.id, result: {} }));
          } else if (message.id !== undefined) {
            socket.send(JSON.stringify({ id: message.id, result: { pong: true } }));
          }
        }));
        await new Promise<void>(resolve => http.listen(socketPath, resolve));
        let settleExit: ((exit: PluginProcessResult) => void) | undefined;
        const exited = new Promise<PluginProcessResult>(resolve => { settleExit = resolve; });
        return {
          pid: process.pid, write: async () => undefined, closeStdin: async () => undefined,
          onOutput: () => ({ dispose: () => undefined }), wait: async () => await exited,
          dispose: async () => {
            if (shouldFailInitialize) {
              let observedOwner: string | null = null;
              try { observedOwner = readFileSync(nativeStartupLock, 'utf8'); } catch { /* An absent owner means unlocked cleanup. */ }
              cleanupWasExclusive.push(observedOwner === startupOwner);
            }
            for (const socket of sockets.clients) socket.terminate();
            await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
            sockets.close();
            await rm(guard, { recursive: true, force: true });
            settleExit?.(result());
            if (shouldFailInitialize && firstCleanupFails) throw new Error('fixture native disposal failed');
          },
        };
      },
    } as unknown as ExecService; // A deliberately narrow fixture for the host-owned process boundary.
    const servers: NonNullable<Awaited<ReturnType<typeof createCodexSharedAppServer>>>[] = [];
    const clients: Awaited<ReturnType<(typeof servers)[number]['createClient']>>[] = [];
    const debug = vi.fn();
    const opening = Promise.allSettled([0, 1].map(async index => {
        const server = await createCodexSharedAppServer({
          exec, processEnv, platform: 'linux', nativeLaunch, logger: { debug },
          dependencies: {
            createRuntimeDirectory: async () => await mkdtemp(join('/tmp', `c-${index}-`)),
            removeRuntimeDirectory: async path => await rm(path, { recursive: true, force: true }),
          },
        });
        if (!server) throw new Error('Expected supported shared control');
        servers.push(server);
        const client = await server.createClient({ cwd: directory, processEnv, configOverrides: [], disableUserMcpServers: false });
        clients.push(client);
        return await client.request('test/ping');
    }));
    try {
      await vi.waitFor(() => expect(debug).toHaveBeenCalledTimes(1));
      releaseInitialization();
      const outcomes = await opening;
      expect(outcomes).toEqual(expect.arrayContaining([
        firstInitializeFails ? { status: 'rejected', reason: firstCleanupFails
          ? expect.objectContaining({ name: 'AggregateError', errors: [expect.objectContaining({ code: -32000 }), expect.objectContaining({ message: 'fixture native disposal failed' })] })
          : expect.any(Error) } : { status: 'fulfilled', value: { pong: true } },
        { status: 'fulfilled', value: { pong: true } },
      ]));
      if (firstInitializeFails) expect(cleanupWasExclusive[0]).toBe(true);
      expect(spawnOptions).toEqual([{ nativeLaunch }, { nativeLaunch }]);
      expect(probeOptions.every(options => options === undefined)).toBe(true);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledWith(expect.any(String), {
        pid: process.pid, heldForMs: expect.any(Number), waitedForMs: expect.any(Number),
      });
    } finally {
      releaseInitialization();
      await opening;
      await Promise.all(clients.map(client => client.dispose()));
      await Promise.all(servers.map(server => server.dispose()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the canonical app-server startup budget for the shared-control version probe', async () => {
    const run = vi.fn(async () => ({
      stdout: new TextEncoder().encode('codex-cli 0.131.0'),
      stderr: new Uint8Array(),
      exitCode: 0,
    }));
    const server = await createCodexSharedAppServer({
      exec: {
        systemTools: { resolve: vi.fn(async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } })) },
        run,
      } as never,
      processEnv: {},
      platform: 'linux',
      dependencies: {
        createRuntimeDirectory: async () => '/tmp/happier-codex-version-probe',
        removeRuntimeDirectory: async () => undefined,
      },
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      args: ['--version'],
      timeoutMs: 60_000,
    }), undefined);
    await server?.dispose();
  });

  it('keeps one private socket server while its published socket becomes connectable', async () => {
    const processHandle = {
      dispose: vi.fn(async () => undefined),
      wait: vi.fn(async () => await new Promise<PluginProcessResult>(() => undefined)),
    };
    const spawn = vi.fn(async () => processHandle);
    const privatePath = '/private/native/app-server.sock';
    const createClient = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('PRIVATE_CONNECT_SENTINEL'), {
        code: 'ECONNREFUSED', syscall: 'connect', path: privatePath,
      }))
      .mockImplementationOnce(async (params: unknown) => ({ params }));
    const removeRuntimeDirectory = vi.fn(async () => undefined);
    const waitForSocket = vi.fn(async () => undefined);
    const server = await createCodexSharedAppServer({
      exec: {
        systemTools: { resolve: vi.fn(async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } })) },
        spawn,
      } as never,
      processEnv: { HOME: '/home/test' },
      platform: 'linux',
      dependencies: {
        readCodexVersion: async () => 'codex-cli 0.131.0',
        createRuntimeDirectory: async () => '/tmp/happier-codex-private',
        waitForSocket,
        removeRuntimeDirectory,
        createClient: createClient as never,
        probeRealtime: async () => true,
      },
    });

    expect(server?.endpoint).toBe('unix:///tmp/happier-codex-private/private/app-server.sock');
    await server?.createClient({
      cwd: '/repo',
      processEnv: {
        HOME: '/home/test',
        HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '90000',
      },
      configOverrides: ['model="gpt-5"'],
      disableUserMcpServers: false,
    });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        'app-server', '--listen', 'unix:///tmp/happier-codex-private/private/app-server.sock',
        '--enable', 'realtime_conversation',
        '-c', 'model="gpt-5"',
      ],
    }), undefined);
    expect(waitForSocket).toHaveBeenCalledWith(
      '/tmp/happier-codex-private/private/app-server.sock',
      processHandle,
      undefined,
    );
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      transport: {
        kind: 'unixWebSocket',
        socketPath: '/tmp/happier-codex-private/private/app-server.sock',
        realtimeConversationAdvertised: true,
      },
    }));
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledTimes(1);
    await server?.dispose();
    expect(processHandle.dispose).toHaveBeenCalledTimes(1);
    expect(removeRuntimeDirectory).toHaveBeenCalledWith('/tmp/happier-codex-private');
  });

  it.each([
    ['linux', 'codex-cli 0.130.0', false],
    ['win32', 'codex-cli 0.153.0', false],
    ['win32', 'codex-cli 0.154.0', false],
    ['win32', 'codex-cli 0.999.0', false],
  ] as const)('uses the first safe shared app-server release on %s: %s', async (platform, version, expected) => {
    const spawn = vi.fn();
    const server = await createCodexSharedAppServer({
      exec: { systemTools: { resolve: vi.fn() }, spawn } as never,
      processEnv: {},
      platform,
      dependencies: {
        readCodexVersion: async () => version,
        createRuntimeDirectory: async () => '/tmp/happier-codex-version-gate',
        removeRuntimeDirectory: async () => undefined,
      },
    });
    expect(Boolean(server)).toBe(expected);
    expect(spawn).not.toHaveBeenCalled();
    await server?.dispose();
  });
});
