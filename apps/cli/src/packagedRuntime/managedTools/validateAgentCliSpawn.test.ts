import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { createEnvKeyScope } from '../../testkit/env/envScope';
import { writeExecutableShimSync } from '../../testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '../../testkit/fs/tempDir';
import { resolveAgentCliManagedCommandPath } from './agentCliResolution';
import { validateAgentCliSpawn } from './validateAgentCliSpawn';

const TEMP_DIRS = new Set<string>();
const scopedEnvKeys = ['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_GEMINI_PATH', 'HAPPIER_CODEX_PATH', 'HOME', 'USERPROFILE', 'CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
let envScope = createEnvKeyScope(scopedEnvKeys);

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(scopedEnvKeys);
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

describe('validateAgentCliSpawn', () => {
  it('validates CLI availability independently of native authentication admission', async () => {
    const root = createTempDirSync('happier-agent-spawn-auth-', tmpdir());
    TEMP_DIRS.add(root);
    const codex = writeExecutableShimSync({
      dir: root, fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
      contents: process.platform === 'win32'
        ? '@echo off\r\necho Not logged in\r\nexit /b 1\r\n'
        : '#!/bin/sh\necho "Not logged in" >&2\nexit 1\n',
    });
    envScope.patch({
      HOME: root, USERPROFILE: root, CODEX_HOME: join(root, '.codex'),
      HAPPIER_HOME_DIR: join(root, 'happier'), HAPPIER_CODEX_PATH: codex,
      OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined,
    });
    // Effective credential admission belongs to daemon child preparation.
    await expect(validateAgentCliSpawn({ agentId: 'codex' })).resolves.toEqual({ ok: true });
  });

  it('accepts managed agent CLIs when PATH is missing the system install', async () => {
    const root = createTempDirSync('happier-agent-spawn-', tmpdir());
    TEMP_DIRS.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    process.env.PATH = join(root, 'empty-path');
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });
    mkdirSync(process.env.PATH, { recursive: true });

    const managedPath = resolveAgentCliManagedCommandPath('gemini', { happyHomeDir: process.env.HAPPIER_HOME_DIR });
    writeExecutable(managedPath);

    await expect(validateAgentCliSpawn({ agentId: 'gemini' })).resolves.toEqual({ ok: true });
  });

  it('returns an agent-specific error when no CLI source is available', async () => {
    const root = createTempDirSync('happier-agent-spawn-', tmpdir());
    TEMP_DIRS.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    process.env.PATH = '';
    delete process.env.HAPPIER_GEMINI_PATH;
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });

    const result = await validateAgentCliSpawn({ agentId: 'gemini' });
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
    const root = createTempDirSync('happier-agent-spawn-', tmpdir());
    TEMP_DIRS.add(root);
    const systemBin = join(root, 'system-bin');
    mkdirSync(systemBin, { recursive: true });
    const systemGeminiPath = join(systemBin, process.platform === 'win32' ? 'gemini.cmd' : 'gemini');
    writeExecutable(systemGeminiPath);
    process.env.PATH = systemBin;
    process.env.HAPPIER_GEMINI_PATH = join(root, 'missing-gemini');

    const result = await validateAgentCliSpawn({ agentId: 'gemini' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.errorMessage).toContain('HAPPIER_GEMINI_PATH');
    expect(result.errorMessage.toLowerCase()).toContain('does not point to a supported cli entrypoint');
  });
});
