import { afterEach, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createGeminiBackend } from './backend';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeTextFile } from '@/testkit/fs/fileHelpers';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const envKeys = [
  'PATH',
  'HAPPIER_HOME_DIR',
  'HAPPIER_GEMINI_PATH',
  'HAPPIER_JS_RUNTIME_PATH',
] as const;

const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

async function createFakeBin(name: string): Promise<{ dir: string; binPath: string }> {
  const fileName = process.platform === 'win32' ? `${name}.cmd` : name;
  const dir = await createTempDir('happier-gemini-backend-');
  tempDirs.add(dir);
  const binPath = await writeExecutableShim({
    dir,
    fileName,
    contents: process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
  });
  return { dir, binPath };
}

afterEach(async () => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

type AcpBackendLike = {
  options: {
    command: string;
  };
};

describe('Gemini ACP backend CLI path resolution', () => {
  it('uses bare gemini command when gemini is on PATH', async () => {
    delete process.env.HAPPIER_GEMINI_PATH;
    const { dir } = await createFakeBin('gemini');
    process.env.PATH = dir;

    const result = createGeminiBackend({
      cwd: '/tmp',
      env: {},
      model: null,
    });

    const backend = result.backend as unknown as AcpBackendLike;
    // When gemini is on PATH, we should use the resolved full path, not bare 'gemini'
    expect(backend.options.command).toContain('gemini');
    expect(backend.options.command).not.toBe('gemini');
  });

  it('uses override path when HAPPIER_GEMINI_PATH is set', async () => {
    process.env.PATH = '';
    const { binPath } = await createFakeBin('gemini-custom');
    process.env.HAPPIER_GEMINI_PATH = binPath;

    const result = createGeminiBackend({
      cwd: '/tmp',
      env: {},
      model: null,
    });

    const backend = result.backend as unknown as AcpBackendLike;
    expect(backend.options.command).toBe(binPath);
  });

  it('wraps node-shebang system CLIs with the configured JS runtime', async () => {
    delete process.env.HAPPIER_GEMINI_PATH;
    const dir = await createTempDir('happier-gemini-path-');
    tempDirs.add(dir);
    const runtimeDir = await createTempDir('happier-gemini-runtime-');
    tempDirs.add(runtimeDir);
    const fake = join(dir, 'gemini');
    const runtimePath = join(runtimeDir, 'node');
    await writeTextFile(fake, '#!/usr/bin/env node\nprocess.stdout.write(\"hi\\n\")\n', { mode: 0o755 });
    await writeTextFile(runtimePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = dir;
    process.env.HAPPIER_JS_RUNTIME_PATH = runtimePath;

    const result = createGeminiBackend({
      cwd: '/tmp',
      env: {},
      model: null,
    });

    const backend = result.backend as unknown as { options: { command: string; args: readonly string[] } };
    expect(backend.options.command).toBe(runtimePath);
    expect(backend.options.args[0]).toBe(fake);
    expect(backend.options.args).toContain('--experimental-acp');
  });

  it('uses managed install path when available', async () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_GEMINI_PATH;

    const homeDir = await createTempDir('happier-gemini-managed-home-');
    tempDirs.add(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;

    const { resolveProviderCliManagedCommandPath } = await import('@/runtime/managedTools/providerCliResolution');
    const binPath = resolveProviderCliManagedCommandPath('gemini', { happyHomeDir: homeDir });
    await mkdir(join(binPath, '..'), { recursive: true });
    await writeTextFile(binPath, '#!/bin/sh\necho ok\n', { mode: 0o755 });

    const result = createGeminiBackend({
      cwd: '/tmp',
      env: {},
      model: null,
    });

    const backend = result.backend as unknown as AcpBackendLike;
    expect(backend.options.command).toBe(binPath);
  });

  it('fails closed when no gemini CLI resolution is available', async () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_GEMINI_PATH;
    delete process.env.HAPPIER_HOME_DIR;

    expect(() =>
      createGeminiBackend({
        cwd: '/tmp',
        env: {},
        model: null,
      }),
    ).toThrow(/Gemini CLI \(gemini\) is not available from any configured source/);
  });
});
