import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { resolveProviderCliManagedCommandPath } from './providerCliResolution';
import { validateProviderCliSpawn } from './validateProviderCliSpawn';

const TEMP_DIRS = new Set<string>();
let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_GEMINI_PATH']);

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_GEMINI_PATH']);
  for (const dir of TEMP_DIRS) {
    removeTempDirSync(dir);
  }
  TEMP_DIRS.clear();
});

function writeExecutable(filePath: string): void {
  writeExecutableShimSync({
    dir: dirname(filePath),
    fileName: basename(filePath),
    contents: process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
  });
}

describe('validateProviderCliSpawn', () => {
  it('accepts managed provider CLIs when PATH is missing the system install', async () => {
    const root = createTempDirSync('happier-provider-spawn-', tmpdir());
    TEMP_DIRS.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    process.env.PATH = join(root, 'empty-path');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });
    mkdirSync(process.env.PATH, { recursive: true });

    const managedPath = resolveProviderCliManagedCommandPath('gemini', { happyHomeDir: process.env.HAPPIER_HOME_DIR });
    writeExecutable(managedPath);

    await expect(validateProviderCliSpawn({ agentId: 'gemini' })).resolves.toEqual({ ok: true });
  });

  it('returns a provider-specific error when no CLI source is available', async () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_GEMINI_PATH;

    const result = await validateProviderCliSpawn({ agentId: 'gemini' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.errorMessage.toLowerCase()).toContain('gemini');
    expect(result.errorMessage).toContain('HAPPIER_GEMINI_PATH');
    expect(result.errorMessage.toLowerCase()).toContain('managed install');
    expect(result.errorMessage.toLowerCase()).toContain('system install');
    expect(result.errorMessage.toLowerCase()).not.toContain('daemon path');
    expect(result.errorMessage.match(/restart the daemon/gi)).toHaveLength(1);
  });

  it('fails closed when an explicit override is set but invalid', async () => {
    const root = createTempDirSync('happier-provider-spawn-', tmpdir());
    TEMP_DIRS.add(root);
    const systemBin = join(root, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    const systemGeminiPath = join(systemBin, process.platform === 'win32' ? 'gemini.cmd' : 'gemini');
    writeExecutable(systemGeminiPath);
    process.env.PATH = systemBin;
    process.env.HAPPIER_GEMINI_PATH = join(root, 'missing-gemini');

    const result = await validateProviderCliSpawn({ agentId: 'gemini' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.errorMessage).toContain('HAPPIER_GEMINI_PATH');
    expect(result.errorMessage.toLowerCase()).toContain('does not point to a supported cli entrypoint');
  });
});
