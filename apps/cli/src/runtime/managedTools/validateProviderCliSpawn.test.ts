import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveProviderCliManagedCommandPath } from './providerCliResolution';
import { validateProviderCliSpawn } from './validateProviderCliSpawn';

const ORIGINAL_ENV = {
  HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
  PATH: process.env.PATH,
  HAPPIER_GEMINI_PATH: process.env.HAPPIER_GEMINI_PATH,
};

const TEMP_DIRS = new Set<string>();

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of TEMP_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }
  TEMP_DIRS.clear();
});

describe('validateProviderCliSpawn', () => {
  it('accepts managed provider CLIs when PATH is missing the system install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-provider-spawn-'));
    TEMP_DIRS.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    process.env.PATH = join(root, 'empty-path');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });
    mkdirSync(process.env.PATH, { recursive: true });

    const managedPath = resolveProviderCliManagedCommandPath('gemini', { happyHomeDir: process.env.HAPPIER_HOME_DIR });
    mkdirSync(join(managedPath, '..'), { recursive: true });
    writeFileSync(managedPath, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(managedPath, 0o755);

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
  });

  it('fails closed when an explicit override is set but invalid', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-provider-spawn-'));
    TEMP_DIRS.add(root);
    const systemBin = join(root, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    const systemGeminiPath = join(systemBin, process.platform === 'win32' ? 'gemini.cmd' : 'gemini');
    writeFileSync(systemGeminiPath, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(systemGeminiPath, 0o755);
    process.env.PATH = systemBin;
    process.env.HAPPIER_GEMINI_PATH = join(root, 'missing-gemini');

    const result = await validateProviderCliSpawn({ agentId: 'gemini' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.errorMessage).toContain('HAPPIER_GEMINI_PATH');
    expect(result.errorMessage.toLowerCase()).toContain('does not point to a supported cli entrypoint');
  });
});
