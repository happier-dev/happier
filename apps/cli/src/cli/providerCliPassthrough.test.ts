import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn<typeof import('node:child_process').spawnSync>() }));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawnSync: spawnSyncMock,
  };
});

import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { maybePassthroughProviderCliInfoRequest } from './providerCliPassthrough';

const tempDirs = new Set<string>();

beforeEach(async () => {
  const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation(actualChildProcess.spawnSync);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

describe('maybePassthroughProviderCliInfoRequest', () => {
  function readSpawnInvocations() {
    return spawnSyncMock.mock.calls.map(([command, args, options]) => ({
      command,
      args,
      stdio: options?.stdio,
      windowsHide: options?.windowsHide,
      windowsVerbatimArguments: options?.windowsVerbatimArguments,
    }));
  }

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

  it('does not native-spawn provider subcommands through the info passthrough path', () => {
    const handled = maybePassthroughProviderCliInfoRequest({
      agentId: 'codex',
      args: ['codex', 'resume', '--all'],
      processEnv: process.env,
    });

    expect(handled).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('runs system JavaScript provider CLIs through the resolved JS runtime', async () => {
    const root = await createTempDir('happier-provider-passthrough-');
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    const runtimeDir = join(root, 'runtime');
    await mkdir(pathDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    const providerPath = await writeExecutableShim({
      dir: pathDir,
      fileName: process.platform === 'win32' ? 'gemini.js' : 'gemini',
      contents: '#!/usr/bin/env node\nprocess.stdout.write("fake-system-gemini-help\\n")\n',
    });
    const markerPath = join(root, 'runtime-marker.txt');
    const runtimePath = await writeExecutableShim({
      dir: runtimeDir,
      fileName: process.platform === 'win32' ? 'node.exe' : 'node',
      contents: `#!/bin/sh\nprintf '%s\\n' "$1" > ${JSON.stringify(markerPath)}\n`,
    });
    // POSIX executes the runtime fixture; Windows stops at the process boundary.
    if (process.platform === 'win32') {
      spawnSyncMock.mockReturnValueOnce(successfulSpawnResult());
    }

    const handled = maybePassthroughProviderCliInfoRequest({
      agentId: 'gemini',
      args: ['--help'],
      processEnv: {
        ...process.env,
        PATH: pathDir,
        HAPPIER_GEMINI_PATH: undefined,
        HAPPIER_JS_RUNTIME_PATH: runtimePath,
        ...(process.platform === 'win32' ? { PATHEXT: '.js;.exe' } : {}),
      },
    });

    expect(handled).toBe(true);
    if (process.platform === 'win32') {
      expect(readSpawnInvocations()).toContainEqual({
        command: runtimePath,
        args: [providerPath, '--help'],
        stdio: 'inherit',
        windowsHide: true,
        windowsVerbatimArguments: undefined,
      });
    } else {
      await expect(readFile(markerPath, 'utf8')).resolves.toContain(providerPath);
    }
  });

  it('wraps Windows shell shims before passthrough invocations', async () => {
    const root = await createTempDir('happier-provider-shell-shim-');
    tempDirs.add(root);
    const providerPath = await writeExecutableShim({
      dir: root, fileName: 'opencode.CMD', contents: '@echo off\r\necho fixture\r\n',
    });
    const cmdPath = await writeExecutableShim({
      dir: root, fileName: 'cmd.exe', contents: 'process boundary fixture',
    });
    spawnSyncMock.mockReturnValueOnce(successfulSpawnResult());
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const handled = maybePassthroughProviderCliInfoRequest({
        agentId: 'opencode',
        args: ['--help'],
        processEnv: { ...process.env, HAPPIER_OPENCODE_PATH: providerPath, ComSpec: cmdPath },
      });

      expect(handled).toBe(true);
      expect(readSpawnInvocations()).toContainEqual({
        command: cmdPath,
        args: ['/d', '/s', '/c', expect.stringMatching(/opencode\.CMD.*--help/u)],
        stdio: 'inherit',
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});
