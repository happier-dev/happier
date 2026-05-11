import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveWindowsCommandInvocationMock, requireProviderCliLaunchSpecMock, spawnSyncMock } = vi.hoisted(() => ({
  resolveWindowsCommandInvocationMock: vi.fn((
    { command, args }: { command: string; args: readonly string[] },
  ): { command: string; args: string[]; windowsVerbatimArguments?: boolean } => ({
    command,
    args: [...args],
  })),
  requireProviderCliLaunchSpecMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('@happier-dev/cli-common/process', () => ({
  resolveWindowsCommandInvocation: resolveWindowsCommandInvocationMock,
}));

vi.mock('@/runtime/managedTools/requireProviderCliLaunchSpec', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/runtime/managedTools/requireProviderCliLaunchSpec')>();
  return {
    ...original,
    requireProviderCliLaunchSpec: requireProviderCliLaunchSpecMock,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawnSync: spawnSyncMock,
  };
});

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { maybePassthroughProviderCliInfoRequest } from './providerCliPassthrough';

const envKeys = [
  'PATH',
  'HAPPIER_GEMINI_PATH',
  'HAPPIER_JS_RUNTIME_PATH',
  'HAPPIER_MANAGED_NODE_BIN',
  'HAPPIER_NODE_PATH',
] as const;

const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

beforeEach(async () => {
  const actualLaunch = await vi.importActual<typeof import('@/runtime/managedTools/requireProviderCliLaunchSpec')>('@/runtime/managedTools/requireProviderCliLaunchSpec');
  requireProviderCliLaunchSpecMock.mockReset();
  requireProviderCliLaunchSpecMock.mockImplementation(actualLaunch.requireProviderCliLaunchSpec);

  const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation(actualChildProcess.spawnSync as any);
});

async function createExecutable(dir: string, name: string, contents: string): Promise<string> {
  return await writeExecutableShim({
    dir,
    fileName: process.platform === 'win32' ? `${name}.cmd` : name,
    contents,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  resolveWindowsCommandInvocationMock.mockReset();
  resolveWindowsCommandInvocationMock.mockImplementation((
    { command, args }: { command: string; args: readonly string[] },
  ): { command: string; args: string[]; windowsVerbatimArguments?: boolean } => ({
    command,
    args: [...args],
  }));
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

describe('maybePassthroughProviderCliInfoRequest', () => {
  function successfulSpawnResult(): SpawnSyncReturns<Buffer> {
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
    spawnSyncMock.mockReturnValue(successfulSpawnResult());
    requireProviderCliLaunchSpecMock.mockReturnValueOnce({
      source: 'system',
      resolvedPath: 'codex',
      command: 'codex',
      args: [],
    });

    const handled = maybePassthroughProviderCliInfoRequest({
      agentId: 'codex',
      args: ['codex', 'resume', '--all'],
      processEnv: process.env,
    });

    expect(handled).toBe(false);
    expect(requireProviderCliLaunchSpecMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('runs system node-shebang provider CLIs through the resolved JS runtime', async () => {
    const root = await createTempDir('happier-provider-passthrough-');
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    const runtimeDir = join(root, 'runtime');
    await mkdir(pathDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    const providerPath = await createExecutable(
      pathDir,
      'gemini',
      '#!/usr/bin/env node\nprocess.stdout.write(\"fake-system-gemini-help\\n\")\n',
    );
    const markerPath = join(root, 'runtime-marker.txt');
    const runtimePath = await createExecutable(
      runtimeDir,
      'node',
      `#!/bin/sh\nprintf '%s\\n' \"$1\" > ${JSON.stringify(markerPath)}\n`,
    );

    process.env.PATH = pathDir;
    process.env.HAPPIER_JS_RUNTIME_PATH = runtimePath;
    if (process.platform === 'win32') {
      spawnSyncMock.mockReturnValueOnce(successfulSpawnResult());
    }

    const handled = maybePassthroughProviderCliInfoRequest({
      agentId: 'gemini',
      args: ['--help'],
      processEnv: { ...process.env, PATH: pathDir, HAPPIER_JS_RUNTIME_PATH: runtimePath },
    });

    expect(handled).toBe(true);
    if (process.platform === 'win32') {
      const [invocation] = resolveWindowsCommandInvocationMock.mock.calls[0] ?? [];
      expect(invocation).toEqual(expect.objectContaining({ args: ['--help'] }));
      expect(invocation.command.toLowerCase()).toBe(providerPath.toLowerCase());
      expect(spawnSyncMock).toHaveBeenCalledWith(
        invocation.command,
        ['--help'],
        expect.objectContaining({ stdio: 'inherit', windowsHide: true }),
      );
      return;
    }
    await expect(readFile(markerPath, 'utf8')).resolves.toContain(providerPath);
  });

  it('wraps Windows shell shims before passthrough invocations', () => {
    spawnSyncMock.mockReturnValue({
      pid: 1,
      output: [],
      stdout: null,
      stderr: null,
      status: 0,
      signal: null,
    } as any);
    resolveWindowsCommandInvocationMock.mockReturnValueOnce({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD --help"'],
      windowsVerbatimArguments: true,
    });
    requireProviderCliLaunchSpecMock.mockReturnValueOnce({
      source: 'override',
      resolvedPath: 'C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD',
      command: 'C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD',
      args: [],
    });

    const handled = maybePassthroughProviderCliInfoRequest({
      agentId: 'opencode',
      args: ['--help'],
      processEnv: {
        ...process.env,
        HAPPIER_OPENCODE_PATH: 'C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      },
    });

    expect(handled).toBe(true);
    expect(resolveWindowsCommandInvocationMock).toHaveBeenCalledWith(expect.objectContaining({
      command: 'C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD',
      args: ['--help'],
    }));
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', '"C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD --help"'],
      expect.objectContaining({ windowsHide: true, windowsVerbatimArguments: true }),
    );
  });
});
