import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeTextFile } from '@/testkit/fs/fileHelpers';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { requireProviderCliLaunchSpec } from './requireProviderCliLaunchSpec';
import { resolveProviderCliManagedCommandPath } from './providerCliResolution';

const envKeys = [
  'PATH',
  'HAPPIER_HOME_DIR',
  'HAPPIER_GEMINI_PATH',
  'HAPPIER_JS_RUNTIME_PATH',
  'HAPPIER_MANAGED_NODE_BIN',
  'HAPPIER_NODE_PATH',
] as const;

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
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);

  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

describe('requireProviderCliLaunchSpec', () => {
  it('wraps system node-shebang provider scripts with the configured JS runtime', async () => {
    const root = await createTempDir('happier-provider-launch-', tmpdir());
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    const runtimeDir = join(root, 'runtime');
    await mkdir(pathDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });

    const providerPath = await createExecutable(
      pathDir,
      'gemini',
      '#!/usr/bin/env node\nprocess.stdout.write("ok\\n")\n',
    );
    const runtimePath = await createExecutable(runtimeDir, 'node', '#!/bin/sh\nexit 0\n');

    process.env.PATH = pathDir;
    process.env.HAPPIER_JS_RUNTIME_PATH = runtimePath;

    expect(requireProviderCliLaunchSpec('gemini')).toEqual({
      source: 'system',
      resolvedPath: providerPath,
      command: runtimePath,
      args: [providerPath],
    });
  });

  it('returns the provider command directly when no wrapper is needed', async () => {
    const root = await createTempDir('happier-provider-launch-direct-', tmpdir());
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    await mkdir(pathDir, { recursive: true });

    const providerPath = await createExecutable(pathDir, 'gemini', '#!/bin/sh\necho ok\n');
    process.env.PATH = pathDir;
    delete process.env.HAPPIER_JS_RUNTIME_PATH;

    expect(requireProviderCliLaunchSpec('gemini')).toEqual({
      source: 'system',
      resolvedPath: providerPath,
      command: providerPath,
      args: [],
    });
  });

  it('keeps managed wrappers as direct commands', async () => {
    const homeDir = await createTempDir('happier-provider-launch-managed-', tmpdir());
    tempDirs.add(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.PATH = '';
    delete process.env.HAPPIER_GEMINI_PATH;

    const binPath = resolveProviderCliManagedCommandPath('gemini', { happyHomeDir: homeDir });
    await writeManagedExecutable(binPath, '#!/bin/sh\necho ok\n');

    expect(requireProviderCliLaunchSpec('gemini')).toEqual({
      source: 'managed',
      resolvedPath: binPath,
      command: binPath,
      args: [],
    });
  });
});
