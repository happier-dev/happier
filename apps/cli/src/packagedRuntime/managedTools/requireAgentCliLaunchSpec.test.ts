import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '../../testkit/env/envScope';
import { writeTextFile } from '../../testkit/fs/fileHelpers';
import { writeExecutableShim } from '../../testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '../../testkit/fs/tempDir';
import { requireAgentCliLaunchSpec } from './requireAgentCliLaunchSpec';
import { resolveAgentCliManagedCommandPath } from './agentCliResolution';

const envKeys = [
  'PATH',
  'HAPPIER_HOME_DIR',
  'HAPPIER_CLAUDE_PATH',
  'HAPPIER_GEMINI_PATH',
  'HAPPIER_OHMYPI_PATH',
  'HAPPIER_JS_RUNTIME_PATH',
  'HAPPIER_MANAGED_NODE_BIN',
  'HAPPIER_NODE_PATH',
] as const;

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

async function createExecutable(root: string, name: string, contents: string): Promise<string> {
  return await writeExecutableShim({
    dir: root,
    fileName: name,
    contents,
  });
}

async function writeManagedExecutable(filePath: string, contents: string): Promise<void> {
  await writeExecutableShim({
    dir: dirname(filePath),
    fileName: basename(filePath),
    contents,
  });
}

afterEach(async () => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);

  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

describe('requireAgentCliLaunchSpec', () => {
  it('routes Windows command shims through the managed Agent CLI runner', async () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const root = await createTempDir('happier-agent-launch-windows-shim-', tmpdir());
    tempDirs.add(root);
    const shimPath = await createExecutable(root, 'claude.cmd', '@echo off\r\n');

    process.env.HAPPIER_CLAUDE_PATH = shimPath;
    process.env.HAPPIER_JS_RUNTIME_PATH = process.execPath;

    const launch = requireAgentCliLaunchSpec('claude');

    expect(launch).toMatchObject({
      source: 'override',
      resolvedPath: shimPath,
      command: process.execPath,
      args: [expect.stringMatching(/agent_cli_windows_shim_runner\.cjs$/u), shimPath],
    });
  });

  it('resolves a managed JS runtime .cmd wrapper to the direct runtime binary on Windows', async () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const root = await createTempDir('happier-agent-launch-windows-runtime-wrapper-', tmpdir());
    tempDirs.add(root);
    const agentCliPath = await createExecutable(root, 'gemini.mjs', 'process.stdout.write("ok\\n");\n');
    const runtimeWrapperPath = join(root, 'tools', 'js-runtime', 'current', 'bin', 'happier-js-runtime.cmd');
    const runtimeBinaryPath = join(root, 'tools', 'js-runtime', 'current', 'runtime', 'node.exe');
    await writeTextFile(runtimeWrapperPath, '@echo off\r\n');
    await writeTextFile(runtimeBinaryPath, 'managed runtime binary');

    process.env.PATH = '';
    process.env.HAPPIER_GEMINI_PATH = agentCliPath;
    process.env.HAPPIER_JS_RUNTIME_PATH = runtimeWrapperPath;
    delete process.env.HAPPIER_MANAGED_NODE_BIN;
    delete process.env.HAPPIER_NODE_PATH;

    // The launch spec is consumed by direct child_process spawns with
    // shell: false, so a .cmd runtime wrapper must resolve to the underlying
    // managed runtime binary (runtime/node.exe), never stay a .cmd shim.
    expect(requireAgentCliLaunchSpec('gemini')).toEqual({
      source: 'override',
      resolvedPath: agentCliPath,
      command: runtimeBinaryPath,
      args: [agentCliPath],
    });
  });

  it('wraps system node-shebang agent scripts with the configured JS runtime', async () => {
    const root = await createTempDir('happier-agent-launch-', tmpdir());
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    const runtimeDir = join(root, 'runtime');
    await mkdir(pathDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });

    const agentCliPath = await createExecutable(
      pathDir,
      'gemini',
      '#!/usr/bin/env node\nprocess.stdout.write("ok\\n")\n',
    );
    const runtimePath = await createExecutable(runtimeDir, 'node', '#!/bin/sh\nexit 0\n');

    process.env.PATH = pathDir;
    process.env.HAPPIER_JS_RUNTIME_PATH = runtimePath;

    expect(requireAgentCliLaunchSpec('gemini')).toEqual({
      source: 'system',
      resolvedPath: agentCliPath,
      command: runtimePath,
      args: [agentCliPath],
    });
  });

  it('returns the agent command directly when no wrapper is needed', async () => {
    const root = await createTempDir('happier-agent-launch-direct-', tmpdir());
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    await mkdir(pathDir, { recursive: true });

    const agentCliPath = await createExecutable(pathDir, 'gemini', '#!/bin/sh\necho ok\n');
    process.env.PATH = pathDir;
    delete process.env.HAPPIER_JS_RUNTIME_PATH;

    expect(requireAgentCliLaunchSpec('gemini')).toEqual({
      source: 'system',
      resolvedPath: agentCliPath,
      command: agentCliPath,
      args: [],
    });
  });

  it('wraps bun-shebang agent scripts with the bun runtime instead of node', async () => {
    const root = await createTempDir('happier-agent-launch-bun-', tmpdir());
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    await mkdir(pathDir, { recursive: true });

    const agentCliPath = await createExecutable(
      pathDir,
      'omp',
      '#!/usr/bin/env bun\nconsole.log("ok")\n',
    );
    const bunPath = await createExecutable(pathDir, 'bun', '#!/bin/sh\nexit 0\n');

    process.env.PATH = pathDir;
    delete process.env.HAPPIER_JS_RUNTIME_PATH;

    expect(requireAgentCliLaunchSpec('ohMyPi')).toEqual({
      source: 'system',
      resolvedPath: agentCliPath,
      command: bunPath,
      args: [agentCliPath],
    });
  });

  it('wraps direct oh-my-pi Bun TypeScript entrypoints with the Bun binary from the enclosing Bun home', async () => {
    const root = await createTempDir('happier-agent-launch-ohmypi-bun-home-', tmpdir());
    tempDirs.add(root);
    const bunRoot = join(root, '.bun');
    const cliDir = join(bunRoot, 'install', 'global', 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'src');
    const bunBinDir = join(bunRoot, 'bin');
    await mkdir(cliDir, { recursive: true });
    await mkdir(bunBinDir, { recursive: true });

    const agentCliPath = await createExecutable(
      cliDir,
      'cli.ts',
      '#!/usr/bin/env bun\nconsole.log("ok")\n',
    );
    const bunPath = await createExecutable(bunBinDir, 'bun', '#!/bin/sh\nexit 0\n');

    process.env.PATH = '';
    process.env.HAPPIER_OHMYPI_PATH = agentCliPath;
    delete process.env.HAPPIER_JS_RUNTIME_PATH;

    expect(requireAgentCliLaunchSpec('ohMyPi')).toEqual({
      source: 'override',
      resolvedPath: agentCliPath,
      command: bunPath,
      args: [agentCliPath],
    });
  });

  it('keeps managed wrappers as direct commands', async () => {
    const homeDir = await createTempDir('happier-agent-launch-managed-', tmpdir());
    tempDirs.add(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.PATH = '';
    delete process.env.HAPPIER_GEMINI_PATH;

    const binPath = resolveAgentCliManagedCommandPath('gemini', { happyHomeDir: homeDir });
    await writeManagedExecutable(binPath, '#!/bin/sh\necho ok\n');

    expect(requireAgentCliLaunchSpec('gemini')).toEqual({
      source: 'managed',
      resolvedPath: binPath,
      command: binPath,
      args: [],
    });
  });
});
