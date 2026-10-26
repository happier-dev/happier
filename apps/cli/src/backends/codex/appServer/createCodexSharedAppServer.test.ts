import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createCodexSharedAppServer } from './createCodexSharedAppServer';
import { buildCodexAppServerConfigOverrides } from './buildCodexAppServerConfigOverrides';
import { createCodexAppServerProcessEnv } from './testkit/fakeCodexAppServer';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

// Keep fallback-lock admission independent from real native starts on this host.
const osBoundary = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: osBoundary.home }) };
});
beforeAll(async () => { osBoundary.home = await mkdtemp(join(tmpdir(), 'codex-shared-lock-home-')); });
afterAll(async () => { await rm(osBoundary.home, { recursive: true, force: true }); });

// Genuine OS enumeration failure; native spawn, socket startup, and cleanup remain real.
const enumeration = vi.hoisted(() => ({ denied: false }));
vi.mock('ps-list', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ps-list')>();
  return { default: () => enumeration.denied
    ? Promise.reject(new Error('process listing unavailable')) : actual.default() };
});

describe('createCodexSharedAppServer', () => {
  it.skipIf(process.platform === 'win32').each([
    ['serializes native startup through the first real initialize handshake for a shared home', false, false, false, false, false],
    ['pins a known SQLite root and records the actual shared-server binary version', false, false, false, true, false],
    ['pins projected SQLite through shared-server auth/config global fallback', false, false, false, true, true],
    ['initializes the default socket server despite an overlong caller TMPDIR', true, false, false, false, false],
    ['keeps failed native startup exclusive through process shutdown', false, true, false, false, false],
    ['preserves live native initialization failure alongside failed process cleanup', false, true, true, false, false],
  ] as const)('%s', async (_name, longCallerTemp, firstInitializeFails, cleanupListingDenied, knownRoot, authConfigFallback) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-codex-shared-native-startup-'));
    if (longCallerTemp) {
      const callerTemp = join(directory, 'caller-temporary-directory-with-a-long-native-unix-socket-prefix');
      await mkdir(callerTemp);
      vi.stubEnv('TMPDIR', callerTemp);
    }
    const executable = join(directory, 'fake-shared-server.mjs');
    if (authConfigFallback) {
      await mkdir(join(directory, 'shared-home'));
      await writeFile(join(directory, 'shared-home', 'auth.json'), '{}');
      await writeFile(join(directory, 'shared-home', 'config.toml'), 'sqlite_home = "relative-store"\n');
    }
    await writeFile(executable, [
      'import { mkdir, rm, writeFile } from "node:fs/promises";',
      'import { join, dirname } from "node:path";',
      'import { createServer } from "node:http";',
      `import WebSocket from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('ws-node')).href)};`,
      'const WebSocketServer = WebSocket.WebSocketServer;',
      'if (process.argv.includes("--version")) { process.stdout.write(process.env.FIXTURE_KNOWN_ROOT === "true" ? "codex-cli 0.162.1\\n" : "fake-codex\\n"); process.exit(0); }',
      'await mkdir(process.env.CODEX_HOME, { recursive: true });',
      'const guard = join(process.env.CODEX_HOME, "native-startup");',
      'await mkdir(guard);',
      'process.on("SIGTERM", async () => { await new Promise(resolve => setTimeout(resolve, 100)); await rm(guard, { recursive: true, force: true }); process.exit(0); });',
      'const socketPath = process.argv.find(arg => arg.startsWith("unix://")).slice(7);',
      'await mkdir(dirname(socketPath), { recursive: true });',
      'const server = createServer();',
      'const sockets = new WebSocketServer({ server });',
      'sockets.on("connection", socket => socket.on("message", async data => {',
      '  const message = JSON.parse(data.toString());',
      '  if (message.method === "initialize") {',
      '    await new Promise(resolve => setTimeout(resolve, 100));',
      '    if (process.env.FIXTURE_INITIALIZE_FAILS === "true") { socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "fixture initialize failed" } })); return; }',
      '    await rm(guard, { recursive: true, force: true });',
      '    if (process.env.FIXTURE_KNOWN_ROOT === "true") { await mkdir(process.env.CODEX_SQLITE_HOME, { recursive: true }); await writeFile(join(process.env.CODEX_SQLITE_HOME, "state_5.sqlite"), "SQLite format 3"); }',
      '    socket.send(JSON.stringify({ id: message.id, result: {} }));',
      '  } else if (message.method === "test/ping") {',
      '    socket.send(JSON.stringify({ id: message.id, result: { pong: true } }));',
      '  }',
      '}));',
      'server.listen(socketPath);',
    ].join('\n'));
    const servers: Awaited<ReturnType<typeof createCodexSharedAppServer>>[] = [];
    const clients: Awaited<ReturnType<Awaited<ReturnType<typeof createCodexSharedAppServer>>['createClient']>>[] = [];
    const stderr: string[] = [];
    const sqliteHome = join(directory, 'sqlite-shared');
    const nativeStartupLock = join(userInfo().homedir, '.happier-codex-native-startup.lock');
    let failedStartupOwner: string | null = null;
    const cleanupWasExclusive: boolean[] = [];
    const spawnProcess = vi.fn(spawn);
    spawnProcess.mockImplementation((...args) => {
      if (knownRoot) expect(JSON.parse(readFileSync(nativeStartupLock, 'utf8'))).toMatchObject({ pid: process.pid });
      if (args[2]?.env?.FIXTURE_INITIALIZE_FAILS === 'true') failedStartupOwner = readFileSync(nativeStartupLock, 'utf8');
      const child = spawn(...args);
      child.stderr?.on('data', chunk => { stderr.push(String(chunk)); });
      return child;
    });
    try {
      const outcomes = await Promise.allSettled(['a', 'b'].map(async suffix => {
        const server = await createCodexSharedAppServer({
          directory,
          processEnv: createCodexAppServerProcessEnv(executable, {
            CODEX_HOME: join(directory, 'shared-home'), CODEX_SQLITE_HOME: knownRoot ? sqliteHome : join(directory, `sqlite-${suffix}`),
            FIXTURE_INITIALIZE_FAILS: String(firstInitializeFails && suffix === 'a'),
            FIXTURE_KNOWN_ROOT: String(knownRoot),
          }),
          dependencies: {
            spawnProcess,
            ...(firstInitializeFails ? { terminateProcess: async child => {
              let observedOwner: string | null = null;
              try { observedOwner = readFileSync(nativeStartupLock, 'utf8'); } catch { /* An absent owner means unlocked cleanup. */ }
              cleanupWasExclusive.push(observedOwner !== null && observedOwner === failedStartupOwner);
              const previousDenial = enumeration.denied;
              enumeration.denied = cleanupListingDenied && suffix === 'a';
              try { await killProcessTree(child); } finally { enumeration.denied = previousDenial; }
            } } : {}),
            // The test's routed TMPDIR may exceed the native Unix socket limit.
            ...(longCallerTemp ? {} : {
              createRuntimeDirectory: async () => await mkdtemp(join('/tmp', 'c-')),
            }),
          },
        });
        servers.push(server);
        const client = await server.createClient();
        clients.push(client);
        return client.request('test/ping');
      }));
      expect({ outcomes, stderr }).toEqual({ outcomes: [
        firstInitializeFails ? { status: 'rejected', reason: cleanupListingDenied
          ? expect.objectContaining({ name: 'AggregateError', errors: [
            expect.objectContaining({ message: 'fixture initialize failed' }),
            expect.objectContaining({ code: 'process_tree_termination_incomplete' }),
          ] }) : expect.objectContaining({ message: 'fixture initialize failed' }) }
          : { status: 'fulfilled', value: { pong: true } },
        { status: 'fulfilled', value: { pong: true } },
      ], stderr: [] });
      if (firstInitializeFails) expect(cleanupWasExclusive[0]).toBe(true);
      if (knownRoot) {
        if (authConfigFallback) expect(await readdir(sqliteHome)).not.toContain('.happier-codex-native-startup.version');
        else expect(readFileSync(join(sqliteHome, '.happier-codex-native-startup.version'), 'utf8')).toBe('0.162.1\n');
        for (const call of spawnProcess.mock.calls) expect(call[1]?.slice(-2)).toEqual(['-c', `sqlite_home=${JSON.stringify(sqliteHome)}`]);
      }
    } finally {
      if (longCallerTemp) vi.unstubAllEnvs();
      await Promise.all(clients.map(client => client.dispose()));
      await Promise.all(servers.map(server => server.dispose()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves native startup failure when the process already exited despite unavailable enumeration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-codex-startup-failure-'));
    enumeration.denied = true;
    try {
      // An actual executable rejects the agent argv before opening a socket. No fake prompt
      // or AppServer logic: this is the native process failure boundary.
      const failure = await createCodexSharedAppServer({
        directory,
        processEnv: { ...process.env, HAPPIER_CODEX_APP_SERVER_BIN: process.execPath },
        dependencies: { createRuntimeDirectory: () => mkdtemp(join(directory, 'runtime-')) },
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ message: expect.stringContaining('exited before its socket was ready') });
      expect(failure).not.toBeInstanceOf(AggregateError);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      enumeration.denied = false;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('owns one socket app-server and gives Happier clients WebSocket transports to that server', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 42, stderr: new EventEmitter() });
    const spawnProcess = vi.fn(() => child as never);
    const createClient = vi.fn(async (params: unknown) => ({ params, dispose: vi.fn() }));
    const terminateProcess = vi.fn(async () => undefined);
    const removeRuntimeDirectory = vi.fn(async () => undefined);
    const waitForSocket = vi.fn(async () => undefined);

    const server = await createCodexSharedAppServer({
      directory: '/workspace',
      processEnv: {
        HOME: '/home/test',
        HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '90000',
      },
      configOverrides: buildCodexAppServerConfigOverrides({}, {
        codexArgs: ['-c', 'model="gpt-5"', '--config=model_reasoning_effort=low'],
      }),
      dependencies: {
        createRuntimeDirectory: async () => '/tmp/happier-codex-private',
        resolveInvocation: async ({ args }) => ({ command: '/usr/bin/codex', args }),
        spawnProcess,
        waitForSocket,
        createClient: createClient as never,
        terminateProcess,
        removeRuntimeDirectory,
      },
    });

    expect(server.endpoint).toBe('unix:///tmp/happier-codex-private/private/app-server.sock');
    expect(spawnProcess).toHaveBeenCalledWith(
      '/usr/bin/codex',
      [
        'app-server', '--listen', 'unix:///tmp/happier-codex-private/private/app-server.sock',
        '-c', 'model="gpt-5"',
        '-c', 'model_reasoning_effort=low',
      ],
      expect.objectContaining({ cwd: '/workspace', stdio: ['ignore', 'ignore', 'pipe'] }),
    );
    expect(waitForSocket).toHaveBeenCalledWith(
      '/tmp/happier-codex-private/private/app-server.sock',
      child,
      90_000,
    );

    await server.createClient();
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/workspace',
      transport: { kind: 'unixWebSocket', socketPath: '/tmp/happier-codex-private/private/app-server.sock' },
    }));

    await server.dispose();
    expect(terminateProcess).toHaveBeenCalledWith(child);
    expect(removeRuntimeDirectory).toHaveBeenCalledWith('/tmp/happier-codex-private');
  });
});
