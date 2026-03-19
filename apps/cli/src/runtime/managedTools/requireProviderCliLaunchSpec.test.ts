import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { requireProviderCliLaunchSpec } from './requireProviderCliLaunchSpec';
import { resolveProviderCliManagedCommandPath } from './providerCliResolution';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
  HAPPIER_GEMINI_PATH: process.env.HAPPIER_GEMINI_PATH,
  HAPPIER_JS_RUNTIME_PATH: process.env.HAPPIER_JS_RUNTIME_PATH,
  HAPPIER_MANAGED_NODE_BIN: process.env.HAPPIER_MANAGED_NODE_BIN,
  HAPPIER_NODE_PATH: process.env.HAPPIER_NODE_PATH,
};

const tempDirs = new Set<string>();

async function createExecutable(root: string, name: string, contents: string): Promise<string> {
  const filePath = join(root, name);
  await writeFile(filePath, contents, 'utf8');
  await chmod(filePath, 0o755);
  return filePath;
}

afterEach(async () => {
  if (ORIGINAL_ENV.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_ENV.PATH;
  if (ORIGINAL_ENV.HAPPIER_HOME_DIR === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = ORIGINAL_ENV.HAPPIER_HOME_DIR;
  if (ORIGINAL_ENV.HAPPIER_GEMINI_PATH === undefined) delete process.env.HAPPIER_GEMINI_PATH;
  else process.env.HAPPIER_GEMINI_PATH = ORIGINAL_ENV.HAPPIER_GEMINI_PATH;
  if (ORIGINAL_ENV.HAPPIER_JS_RUNTIME_PATH === undefined) delete process.env.HAPPIER_JS_RUNTIME_PATH;
  else process.env.HAPPIER_JS_RUNTIME_PATH = ORIGINAL_ENV.HAPPIER_JS_RUNTIME_PATH;
  if (ORIGINAL_ENV.HAPPIER_MANAGED_NODE_BIN === undefined) delete process.env.HAPPIER_MANAGED_NODE_BIN;
  else process.env.HAPPIER_MANAGED_NODE_BIN = ORIGINAL_ENV.HAPPIER_MANAGED_NODE_BIN;
  if (ORIGINAL_ENV.HAPPIER_NODE_PATH === undefined) delete process.env.HAPPIER_NODE_PATH;
  else process.env.HAPPIER_NODE_PATH = ORIGINAL_ENV.HAPPIER_NODE_PATH;

  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('requireProviderCliLaunchSpec', () => {
  it('wraps system node-shebang provider scripts with the configured JS runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-provider-launch-'));
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
    const root = await mkdtemp(join(tmpdir(), 'happier-provider-launch-direct-'));
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
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-provider-launch-managed-'));
    tempDirs.add(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.PATH = '';
    delete process.env.HAPPIER_GEMINI_PATH;

    const binPath = resolveProviderCliManagedCommandPath('gemini', { happyHomeDir: homeDir });
    await mkdir(join(binPath, '..'), { recursive: true });
    await writeFile(binPath, '#!/bin/sh\necho ok\n', 'utf8');
    await chmod(binPath, 0o755);

    expect(requireProviderCliLaunchSpec('gemini')).toEqual({
      source: 'managed',
      resolvedPath: binPath,
      command: binPath,
      args: [],
    });
  });
});
