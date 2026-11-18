import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';

import { createCodexSharedAppServer } from './sharedServer.js';
import { admitTestExecSpawn } from './client.test-support';

type AgentNativeLaunchQualifier = NonNullable<NonNullable<Parameters<ExecService['spawn']>[1]>['nativeLaunch']>;

const osBoundary = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, userInfo: () => ({ ...os.userInfo(), homedir: osBoundary.home }) };
});

const socketWaitStop = new Error('launch spec captured');

/**
 * Characterizes the exact spawn request the Codex shared app-server hands to Exec (argv, env, cwd,
 * output limits, native-launch qualifier): the spec a parked launch must reproduce byte for byte.
 * Exec is the host process boundary; probes, the native startup lock and the spec builder are real.
 */
async function captureSharedAppServerSpawn(input: Readonly<{ directory: string; nativeProxy: boolean }>) {
  const spawns: Array<Readonly<{ request: Parameters<ExecService['spawn']>[0]; nativeLaunch: unknown }>> = [];
  const runs: Array<Readonly<{ args: readonly string[]; env: unknown }>> = [];
  const nativeLaunch = Object.freeze({ fixture: 'native' }) as unknown as AgentNativeLaunchQualifier;
  const directoryLaunch = Object.freeze({ fixture: 'directory' }) as unknown as AgentNativeLaunchQualifier;
  const result = (stdout: string): PluginProcessResult => ({
    termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
    stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
  });
  const exec = {
    withSpawnAdmission: admitTestExecSpawn,
    prepareNativeSocketDirectory: async () => ({ path: input.directory, dispose: async () => undefined,
      ...(input.nativeProxy ? { nativeProxy: true, nativeLaunch: directoryLaunch } : {}) }),
    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' } }) },
    run: async (request: Parameters<ExecService['run']>[0]) => {
      runs.push({ args: request.args ?? [], env: request.env });
      return result(request.args?.includes('--version') ? 'codex-cli 0.162.1' : 'realtime_conversation under development true');
    },
    spawn: async (request: Parameters<ExecService['spawn']>[0], options: Parameters<ExecService['spawn']>[1]) => {
      spawns.push({ request, nativeLaunch: options?.nativeLaunch });
      return { pid: 1, write: async () => undefined, closeStdin: async () => undefined,
        onOutput: () => ({ dispose: () => undefined }), waitForExit: async () => await new Promise(() => undefined),
        wait: async () => await new Promise(() => undefined), dispose: async () => undefined };
    },
  } as unknown as ExecService; // A deliberately narrow fixture for the host-owned process boundary.
  const processEnv = {
    CODEX_HOME: join(input.directory, 'auth'),
    CODEX_SQLITE_HOME: join(input.directory, 'sqlite'),
    PATH: '/fixture/bin',
    HAPPIER_CODEX_APP_SERVER_BIN: '/fixture/codex',
  };
  const server = await createCodexSharedAppServer({
    exec, processEnv, platform: 'linux', nativeLaunch,
    dependencies: { waitForSocket: async () => { throw socketWaitStop; }, removeRuntimeDirectory: async () => undefined },
  });
  if (!server) throw new Error('Expected supported shared control');
  await expect(server.createClient({ cwd: input.directory, processEnv,
    configOverrides: ['model="gpt-fixture"'], disableUserMcpServers: true })).rejects.toBe(socketWaitStop);
  const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(input.directory, '<dir>'));
  return normalize({ endpoint: server.endpoint, runs, spawns: spawns.map(spawn => ({ ...spawn.request,
    nativeLaunch: spawn.nativeLaunch === nativeLaunch ? 'native' : spawn.nativeLaunch === directoryLaunch ? 'directory' : null })) });
}

describe('Codex shared app-server launch spec', () => {
  let directory = '';
  beforeEach(async () => {
    osBoundary.home = await mkdtemp(join(tmpdir(), 'codex-spec-home-'));
    directory = await mkdtemp(join(tmpdir(), 'codex-spec-'));
  });
  afterEach(async () => {
    await rm(osBoundary.home, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'linux').each([false, true])('keeps the recorded spawn request (native proxy: %s)', async nativeProxy => {
    expect(await captureSharedAppServerSpawn({ directory, nativeProxy })).toEqual(EXPECTED[String(nativeProxy) as 'false' | 'true']);
  });
});

const ENV = { CODEX_HOME: '<dir>/auth', CODEX_SQLITE_HOME: '<dir>/sqlite', HAPPIER_CODEX_APP_SERVER_BIN: '/fixture/codex',
  HAPPIER_CODEX_PATH: '/fixture/codex', PATH: '/fixture/bin' };
const ENDPOINT = 'unix://<dir>/private/app-server.sock';
const expected = (input: Readonly<{ startupOverrides: readonly string[]; nativeLaunch: 'native' | 'directory' }>) => ({
  endpoint: ENDPOINT,
  runs: [{ args: ['--version'], env: ENV }, { args: ['features', 'list'], env: ENV }],
  spawns: [{
    args: ['app-server', '--listen', ENDPOINT, '--enable', 'realtime_conversation', '-c', 'model="gpt-fixture"', ...input.startupOverrides],
    cwd: { relativePath: '', root: 'workspace' }, env: ENV, executable: { id: 'codex-cli', kind: 'systemTool' },
    maxStderrBytes: 16_384, maxStdoutBytes: 4_096, nativeLaunch: input.nativeLaunch,
  }],
});
// Recorded from the pre-extraction bytes (HEAD de178a62c11 plus the PARK-BUILD-5 builder hunk): golden-1/2.log.
const EXPECTED = {
  false: expected({ startupOverrides: ['-c', 'sqlite_home="<dir>/sqlite"'], nativeLaunch: 'native' }),
  // Under the native proxy the startup lock drops the host sqlite_home (the shim selects CODEX_HOME).
  true: expected({ startupOverrides: [], nativeLaunch: 'directory' }),
};
