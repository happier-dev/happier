import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGeminiBackend } from './backend';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
  HAPPIER_GEMINI_PATH: process.env.HAPPIER_GEMINI_PATH,
  HAPPIER_JS_RUNTIME_PATH: process.env.HAPPIER_JS_RUNTIME_PATH,
};

const tempDirs = new Set<string>();

async function createFakeBin(name: string): Promise<{ dir: string; binPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-gemini-backend-'));
  tempDirs.add(dir);
  const binPath = join(dir, name);
  await writeFile(binPath, '#!/bin/sh\necho ok\n', 'utf8');
  await chmod(binPath, 0o755);
  return { dir, binPath };
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
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
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
    const dir = await mkdtemp(join(tmpdir(), 'happier-gemini-path-'));
    tempDirs.add(dir);
    const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-gemini-runtime-'));
    tempDirs.add(runtimeDir);
    const fake = join(dir, 'gemini');
    const runtimePath = join(runtimeDir, 'node');
    await writeFile(fake, '#!/usr/bin/env node\nprocess.stdout.write(\"hi\\n\")\n', 'utf8');
    await chmod(fake, 0o755);
    await writeFile(runtimePath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(runtimePath, 0o755);
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

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-gemini-managed-home-'));
    tempDirs.add(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;

    const { resolveProviderCliManagedCommandPath } = await import('@/runtime/managedTools/providerCliResolution');
    const binPath = resolveProviderCliManagedCommandPath('gemini', { happyHomeDir: homeDir });
    await mkdir(join(binPath, '..'), { recursive: true });
    await writeFile(binPath, '#!/bin/sh\necho ok\n', 'utf8');
    await chmod(binPath, 0o755);

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
