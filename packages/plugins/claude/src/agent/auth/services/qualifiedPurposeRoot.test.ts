import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { shareClaudeUserConfigWithIsolatedRoot } from './qualifiedPurposeRoot.js';

let sourceDir: string;
let rootDir: string;

beforeEach(async () => {
  sourceDir = await mkdtemp(join(tmpdir(), 'claude-user-config-'));
  rootDir = await mkdtemp(join(tmpdir(), 'claude-isolated-root-'));
});

afterEach(async () => {
  await rm(sourceDir, { recursive: true, force: true });
  await rm(rootDir, { recursive: true, force: true });
});

async function share(): Promise<void> {
  await shareClaudeUserConfigWithIsolatedRoot({
    rootDir,
    processEnv: { CLAUDE_CONFIG_DIR: sourceDir } as NodeJS.ProcessEnv,
    stateMode: 'shared',
  });
}

async function readProjectedSettings(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(rootDir, name), 'utf8')) as Record<string, unknown>;
}

describe('shareClaudeUserConfigWithIsolatedRoot', () => {
  it('projects user settings without the credential-bearing keys that answer for the pinned route', async () => {
    await writeFile(join(sourceDir, 'settings.json'), JSON.stringify({
      apiKeyHelper: '/usr/local/bin/print-my-anthropic-key',
      env: {
        ANTHROPIC_AUTH_TOKEN: 'personal-oauth-token',
        ANTHROPIC_API_KEY: 'personal-api-key',
        ANTHROPIC_BASE_URL: 'https://personal.example.test',
        EDITOR: 'vim',
      },
      permissions: { allow: ['Bash(git status)'] },
      statusLine: { type: 'command', command: 'my-status' },
    }));

    await share();

    // A symlink would hand the pinned root the user's live credential file.
    const projected = await lstat(join(rootDir, 'settings.json'));
    expect(projected.isSymbolicLink()).toBe(false);

    const settings = await readProjectedSettings('settings.json');
    expect(settings.apiKeyHelper).toBeUndefined();
    expect(settings.env).toEqual({ EDITOR: 'vim' });
    expect(settings.permissions).toEqual({ allow: ['Bash(git status)'] });
    expect(settings.statusLine).toEqual({ type: 'command', command: 'my-status' });
  });

  it('withholds a Provider-owned environment name in any letter case', async () => {
    // Windows environment names are case-insensitive, so a mixed-case entry in
    // the user's settings reaches the launched process as the exact Provider
    // binding variable the pinned root exists to withhold.
    await writeFile(join(sourceDir, 'settings.json'), JSON.stringify({
      env: {
        anthropic_base_url: 'https://personal.example.test',
        Anthropic_Auth_Token: 'personal-oauth-token',
        ANTHROPIC_API_key: 'personal-api-key',
        EDITOR: 'vim',
      },
    }));

    await share();

    expect((await readProjectedSettings('settings.json')).env).toEqual({ EDITOR: 'vim' });
  });

  it('projects the same sanitized shape for the local settings overlay', async () => {
    await writeFile(join(sourceDir, 'settings.local.json'), JSON.stringify({
      apiKeyHelper: '/usr/local/bin/print-my-anthropic-key',
      env: { ANTHROPIC_API_KEY: 'personal-api-key', TERM: 'xterm' },
    }));

    await share();

    expect((await lstat(join(rootDir, 'settings.local.json'))).isSymbolicLink()).toBe(false);
    const settings = await readProjectedSettings('settings.local.json');
    expect(settings.apiKeyHelper).toBeUndefined();
    expect(settings.env).toEqual({ TERM: 'xterm' });
  });

  it('omits a settings document it cannot sanitize instead of linking it verbatim', async () => {
    await writeFile(join(sourceDir, 'settings.json'), '{ this is not json');

    await share();

    expect(existsSync(join(rootDir, 'settings.json'))).toBe(false);
  });

  it('still shares the user workspace configuration by link', async () => {
    await mkdir(join(sourceDir, 'skills'), { recursive: true });
    await writeFile(join(sourceDir, 'CLAUDE.md'), '# user memory\n');

    await share();

    expect((await lstat(join(rootDir, 'skills'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(rootDir, 'skills'))).toBe(join(sourceDir, 'skills'));
    expect(await readFile(join(rootDir, 'CLAUDE.md'), 'utf8')).toBe('# user memory\n');
  });

  it('never shares the account identity entries', async () => {
    await writeFile(join(sourceDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {} }));
    await writeFile(join(sourceDir, '.claude.json'), JSON.stringify({ oauthAccount: {} }));

    await share();

    expect(existsSync(join(rootDir, '.credentials.json'))).toBe(false);
    expect(existsSync(join(rootDir, '.claude.json'))).toBe(false);
  });
});

describe('shareClaudeUserConfigWithIsolatedRoot state sharing', () => {
  it('links the descriptor state entries when the user shares provider state', async () => {
    await mkdir(join(sourceDir, 'projects'), { recursive: true });

    await shareClaudeUserConfigWithIsolatedRoot({
      rootDir,
      processEnv: { CLAUDE_CONFIG_DIR: sourceDir } as NodeJS.ProcessEnv,
      stateMode: 'shared',
    });

    expect((await lstat(join(rootDir, 'projects'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(rootDir, 'projects'))).toBe(join(sourceDir, 'projects'));
  });

  it('never shares the descriptor state entries when the user isolated provider state', async () => {
    await mkdir(join(sourceDir, 'projects'), { recursive: true });
    await mkdir(join(sourceDir, 'skills'), { recursive: true });

    await shareClaudeUserConfigWithIsolatedRoot({
      rootDir,
      processEnv: { CLAUDE_CONFIG_DIR: sourceDir } as NodeJS.ProcessEnv,
      stateMode: 'isolated',
    });

    expect(existsSync(join(rootDir, 'projects'))).toBe(false);
    // Isolating history must not isolate the workspace configuration.
    expect((await lstat(join(rootDir, 'skills'))).isSymbolicLink()).toBe(true);
  });
});
