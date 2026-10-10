import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { reloadConfiguration } from '@/configuration';

// Vendor execution is the process boundary; contribution admission, projection,
// command resolution and policy remain real.
const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawnSync,
}));

import { dispatchCli } from './dispatch';

describe('dispatchCli command policy', () => {
  let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>;
  let directory: string;
  let executable: string;
  const command = 'acme.local-tui/local';
  const processExit = new Error('fixture-process-exit');

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'happier-command-policy-'));
    executable = await writeExecutableShim({
      dir: directory,
      fileName: process.platform === 'win32' ? 'local-tui-fixture.cmd' : 'local-tui-fixture',
      contents: process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n',
    });
    fixture = await createAuthoredAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      plugins: [{
        manifest: {
          schemaVersion: 2, id: 'acme.local-tui', version: '1.0.0', displayName: 'Local TUI',
          runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
          contributes: { agents: [{
            id: 'local', title: 'Local TUI', runtime: { kind: 'custom' }, primary: 'sessions',
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
            cli: {
              executable: { binaryName: 'local-tui-fixture', sourcePreference: 'system-first' },
              install: { managed: null, manual: { kind: 'command' } },
              auth: { support: 'status_only', loginLaunches: [] },
              commandPolicy: { daemonAutostartDefault: 'preferLocalTui' },
            },
          }] },
        },
        files: {
          'daemon.mjs': `import { createRuntime } from './runtime.mjs';
            export function activate(api) { api.agents.register('local', createRuntime, {
              sessionRunnerFactory: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 }
            }); }`,
          'runtime.mjs': `export function createRuntime() { return { sessions: {
            open: async () => { throw new Error('Native help must not open a Session'); }
          } }; }`,
        },
      }],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    reloadConfiguration();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await fixture?.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it('honors an admitted external Agent local-TUI default through its real command', async () => {
    const previousIn = process.stdin.isTTY;
    const previousOut = process.stdout.isTTY;
    vi.stubEnv('HAPPIER_HOME_DIR', fixture.happyHomeDir);
    reloadConfiguration();
    vi.stubEnv('PATH', `${directory}${delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('HAPPIER_SESSION_AUTOSTART_DAEMON', undefined);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    vi.spyOn(process, 'exit').mockImplementation(() => { throw processExit; });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    spawnSync.mockClear();
    try {
      await expect(dispatchCli({
        args: [command, '--help'], rawArgv: ['happier', command, '--help'], terminalRuntime: null,
      })).rejects.toBe(processExit);
      expect(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBe('0');
      expect(spawnSync).toHaveBeenCalledWith(executable, ['--help'], expect.any(Object));
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: previousIn, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: previousOut, configurable: true });
    }
  });
});
