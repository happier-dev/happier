import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock, writeSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn<typeof import('node:child_process').spawnSync>(),
  writeSyncMock: vi.fn<typeof import('node:fs').writeSync>(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: spawnSyncMock,
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  writeSync: writeSyncMock,
}));

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { maybePassthroughProviderCliInfoRequest, passthroughProviderCliArgs } from './providerCliPassthrough';

const envKeys = [
  'PATH',
  'HAPPIER_GEMINI_PATH',
  'HAPPIER_JS_RUNTIME_PATH',
  'HAPPIER_MANAGED_NODE_BIN',
  'HAPPIER_NODE_PATH',
] as const;

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

beforeEach(async () => {
  const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation(actualChildProcess.spawnSync);
  writeSyncMock.mockReset();
});

afterEach(async () => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
  vi.restoreAllMocks();
  spawnSyncMock.mockReset();
  writeSyncMock.mockReset();
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

function successfulSpawnResult() {
  return {
    pid: 1,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: 0,
    signal: null,
  };
}

describe('provider CLI passthrough', () => {
  it('does not native-spawn provider subcommands through the info passthrough path', () => {
    spawnSyncMock.mockReturnValue(successfulSpawnResult());

    expect(maybePassthroughProviderCliInfoRequest({
      agentId: 'codex',
      args: ['codex', 'resume', '--all'],
      processEnv: process.env,
    })).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('runs system JavaScript provider CLIs through the resolved JS runtime', async () => {
    const root = await createTempDir('happier-provider-passthrough-');
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    await mkdir(pathDir, { recursive: true });
    const markerPath = join(root, 'runtime-marker.json');
    const providerPath = await writeExecutableShim({
      dir: pathDir,
      fileName: process.platform === 'win32' ? 'gemini.js' : 'gemini',
      contents: '#!/usr/bin/env node\n'
        + 'require("node:fs").writeFileSync(' + JSON.stringify(markerPath)
        + ', JSON.stringify(process.argv.slice(2)));\n',
    });

    envScope.patch({
      PATH: pathDir,
      HAPPIER_GEMINI_PATH: undefined,
      HAPPIER_JS_RUNTIME_PATH: process.execPath,
      HAPPIER_MANAGED_NODE_BIN: undefined,
      HAPPIER_NODE_PATH: undefined,
    });

    expect(maybePassthroughProviderCliInfoRequest({
      agentId: 'gemini',
      args: ['--help'],
      processEnv: {
        ...process.env,
        ...(process.platform === 'win32' ? { PATHEXT: '.js;.exe' } : {}),
      },
    })).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      process.execPath,
      [providerPath, '--help'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
    );
    await expect(readFile(markerPath, 'utf8')).resolves.toBe(JSON.stringify(['--help']));
  });

  it('routes Windows shell shims through the real managed Agent CLI runner before passthrough', async () => {
    const root = await createTempDir('happier-provider-passthrough-windows-');
    tempDirs.add(root);
    const shimPath = await writeExecutableShim({
      dir: root,
      fileName: 'opencode.CMD',
      contents: '@echo off\r\n',
    });
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
    // The Windows process is the boundary; catalog, resolution and launch preparation stay real.
    spawnSyncMock.mockReturnValue(successfulSpawnResult());

    expect(maybePassthroughProviderCliInfoRequest({
      agentId: 'opencode',
      args: ['--help'],
      processEnv: {
        ...process.env,
        HAPPIER_OPENCODE_PATH: shimPath,
        HAPPIER_JS_RUNTIME_PATH: process.execPath,
      },
    })).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/agent_cli_windows_shim_runner\.cjs$/u), shimPath, '--help'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
  });

  it('preserves exact provider-native info arguments and replays captured output', async () => {
    const root = await createTempDir('happier-provider-passthrough-output-');
    tempDirs.add(root);
    const providerPath = await writeExecutableShim({
      dir: root,
      fileName: 'codex.mjs',
      contents: '#!/usr/bin/env node\n',
    });
    spawnSyncMock.mockReturnValue({
      ...successfulSpawnResult(),
      stdout: Buffer.from('provider stdout\n'),
      stderr: Buffer.from('provider stderr\n'),
    });

    passthroughProviderCliArgs({
      agentId: 'codex',
      providerArgs: ['exec', '--help'],
      processEnv: {
        ...process.env,
        HAPPIER_CODEX_PATH: providerPath,
        HAPPIER_JS_RUNTIME_PATH: process.execPath,
      },
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      process.execPath,
      [providerPath, 'exec', '--help'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
    expect(writeSyncMock).toHaveBeenNthCalledWith(1, 1, Buffer.from('provider stdout\n'));
    expect(writeSyncMock).toHaveBeenNthCalledWith(2, 2, Buffer.from('provider stderr\n'));
  });
});
