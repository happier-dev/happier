import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createCodexSharedAppServer } from './sharedServer';
import { createCodexControlSocketFixture } from './client.test-support';
import { connectManagedJsonRpcTestClient } from '../../../../../../../apps/cli/src/testkit/process/managedJsonRpc';

type NativeLaunch = NonNullable<NonNullable<Parameters<ExecService['spawn']>[1]>['nativeLaunch']>;
const osBoundary = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, userInfo: () => ({ ...os.userInfo(), homedir: osBoundary.home }) };
});
const result = (stdout = ''): PluginProcessResult => ({
  termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
  stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
});

// Exec is the native process/filesystem boundary. All socket publication,
// readiness, cancellation, protocol initialization and cleanup owners are real.
it.skipIf(process.platform !== 'linux').each([994, 996])('uses the admitted UID %s proxy for an alias whose physical socket the host cannot stat', async uid => {
  const root = await mkdtemp('/tmp/h-cx-');
  osBoundary.home = root;
  const directory = join(root, 'transport');
  await mkdir(directory, { mode: 0o700 });
  const original = Object.freeze({}) as NativeLaunch;
  const prepared = Object.freeze({}) as NativeLaunch;
  const socketPath = join(directory, 'private', 'app-server.sock');
  const peer = await createCodexControlSocketFixture(join(root, 'peer.sock'), message => message.id === undefined ? undefined : {});
  let proxyConnections = 0;
  let serverDisposed = false;
  const exec = {
    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } }) },
    run: async (request: Parameters<ExecService['run']>[0]) => result(request.args.includes('--version') ? 'codex-cli 0.162.1' : ''),
    prepareNativeSocketDirectory: async (options: { nativeLaunch?: NativeLaunch }) => {
      expect(options.nativeLaunch).toBe(original);
      return { path: directory, nativeLaunch: prepared, nativeProxy: true,
        dispose: async () => { await rm(directory, { recursive: true, force: true }); } };
    },
    spawn: async (request: Parameters<ExecService['spawn']>[0], options: Parameters<ExecService['spawn']>[1]) => {
      expect(options?.nativeLaunch).toBe(prepared);
      expect(request.args[request.args.indexOf('--listen') + 1]).toBe(`unix://${socketPath}`);
      await mkdir(dirname(socketPath), { mode: 0o700 });
      // Mirrors native's alias into /tmp/codex-daemon-UID (0700) and socket0600.
      // A missing target deterministically proves the host never follows it.
      await symlink(`/tmp/codex-daemon-${uid}/not-host-readable.sock`, socketPath);
      return { wait: () => new Promise<PluginProcessResult>(() => {}), dispose: async () => { serverDisposed = true; } };
    },
    clients: {
      connectJsonRpc: async () => { throw Object.assign(new Error('Host cannot reach the native socket'), { code: 'EACCES' }); },
      spawn: async (spec: { launch: { args: readonly string[] } }, options: { nativeLaunch?: NativeLaunch }) => {
        expect(options.nativeLaunch).toBe(original);
        expect(spec.launch.args).toEqual(['app-server', 'proxy', '--sock', socketPath]);
        proxyConnections++;
        const connection = await connectManagedJsonRpcTestClient({ cwd: root, socketPath: join(root, 'peer.sock') });
        return { client: connection.client, wait: () => new Promise<PluginProcessResult>(() => {}), dispose: () => connection.dispose() };
      },
    },
  } as unknown as ExecService; // Native daemon transport/process adapter fixture.
  const server = await createCodexSharedAppServer({ exec, nativeLaunch: original, processEnv: { CODEX_SQLITE_HOME: root }, platform: 'linux' });
  try {
    expect(server).not.toBeNull();
    const client = await server!.createClient({ cwd: root, processEnv: { CODEX_SQLITE_HOME: root }, configOverrides: [], disableUserMcpServers: false });
    expect(await client.request('thread/list', {})).toEqual({});
    expect(proxyConnections).toBe(1);
    await client.dispose();
  } finally {
    await server?.dispose();
    await peer.close();
    await rm(root, { recursive: true, force: true });
  }
  expect(serverDisposed).toBe(true);
  await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform !== 'linux')('cancels unpublished native socket readiness before launching any proxy and cleans its held directory', async () => {
  const root = await mkdtemp('/tmp/h-cx-');
  osBoundary.home = root;
  const controller = new AbortController();
  let disposed = false;
  let proxyStarted = false;
  const exec = {
    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } }) },
    run: async (request: Parameters<ExecService['run']>[0]) => result(request.args.includes('--version') ? 'codex-cli 0.162.1' : ''),
    prepareNativeSocketDirectory: async () => ({ path: root, nativeProxy: true,
      dispose: async () => { await rm(root, { recursive: true, force: true }); } }),
    spawn: async () => { controller.abort(); return { wait: () => new Promise<PluginProcessResult>(() => {}), dispose: async () => { disposed = true; } }; },
    clients: { spawn: async () => { proxyStarted = true; throw new Error('No proxy before publication'); } },
  } as unknown as ExecService;
  const server = await createCodexSharedAppServer({ exec, processEnv: { CODEX_SQLITE_HOME: root }, signal: controller.signal, platform: 'linux' });
  try {
    await expect(server!.createClient({ cwd: root, processEnv: { CODEX_SQLITE_HOME: root }, configOverrides: [], disableUserMcpServers: false })).rejects.toBeDefined();
    expect(proxyStarted).toBe(false);
    expect(disposed).toBe(true);
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await server?.dispose(); await rm(root, { recursive: true, force: true }); }
});
