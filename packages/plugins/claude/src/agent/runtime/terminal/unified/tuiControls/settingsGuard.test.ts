import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createClaudeSettingsGuard,
  resolveClaudeConfigRootFromEnv,
} from './settingsGuard.js';

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveClaudeConfigRootFromEnv', () => {
  it('prefers an explicit CLAUDE_CONFIG_DIR over the real home', () => {
    expect(resolveClaudeConfigRootFromEnv({ CLAUDE_CONFIG_DIR: '/srv/profile/claude', HOME: '/home/u' }))
      .toBe('/srv/profile/claude');
  });

  it('falls back to the Happier-managed config dir before the home default', () => {
    expect(resolveClaudeConfigRootFromEnv({ HAPPIER_CLAUDE_CONFIG_DIR: '/srv/managed/claude', HOME: '/home/u' }))
      .toBe('/srv/managed/claude');
  });

  it('falls back to ~/.claude in a no-profile real-home session', () => {
    expect(resolveClaudeConfigRootFromEnv({ HOME: '/home/u' })).toBe(join('/home/u', '.claude'));
  });

  it('resolves USERPROFILE when HOME is absent (Windows launch envs)', () => {
    expect(resolveClaudeConfigRootFromEnv({ USERPROFILE: '/Users/win' })).toBe(join('/Users/win', '.claude'));
  });
});

describe('createClaudeSettingsGuard — copied connected-service home (real file)', () => {
  it('restores the original bytes when /model adds a default model key', async () => {
    const configDir = await makeTempDir('claude-copied-');
    const settingsPath = join(configDir, 'settings.json');
    const original = JSON.stringify({ statusLine: { type: 'command' } }, null, 2);
    await writeFile(settingsPath, original, 'utf8');

    const guard = createClaudeSettingsGuard({ configDir });
    const session = await guard.acquire();

    // Simulate `/model` persisting a default model into the active config.
    await writeFile(settingsPath, JSON.stringify({ statusLine: { type: 'command' }, model: 'claude-sonnet-4-6' }, null, 2), 'utf8');

    const restore = await session.restore();
    await session.release();

    expect(restore.ok).toBe(true);
    expect(await readFile(settingsPath, 'utf8')).toBe(original);
  });

  it('deletes a settings file the control created when none existed before', async () => {
    const configDir = await makeTempDir('claude-create-');
    const settingsPath = join(configDir, 'settings.json');

    const guard = createClaudeSettingsGuard({ configDir });
    const session = await guard.acquire();

    await writeFile(settingsPath, JSON.stringify({ model: 'sonnet' }), 'utf8');

    const restore = await session.restore();
    await session.release();

    expect(restore.ok).toBe(true);
    await expect(stat(settingsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('createClaudeSettingsGuard — linked connected-service home (symlink write-through)', () => {
  it('restores the real symlink target and keeps the link intact', async () => {
    const realHome = await makeTempDir('claude-realhome-');
    const realClaude = join(realHome, '.claude');
    await mkdir(realClaude, { recursive: true });
    const realSettings = join(realClaude, 'settings.json');
    const original = JSON.stringify({ theme: 'dark' }, null, 2);
    await writeFile(realSettings, original, 'utf8');

    const linkedConfigDir = await makeTempDir('claude-linked-');
    const linkedSettings = join(linkedConfigDir, 'settings.json');
    await symlink(realSettings, linkedSettings);

    const guard = createClaudeSettingsGuard({ configDir: linkedConfigDir });
    const session = await guard.acquire();

    // `/model` writes through the symlink, mutating the user's real settings.
    await writeFile(linkedSettings, JSON.stringify({ theme: 'dark', model: 'sonnet' }, null, 2), 'utf8');

    const restore = await session.restore();
    await session.release();

    expect(restore.ok).toBe(true);
    expect(await readFile(realSettings, 'utf8')).toBe(original);
    expect((await lstat(linkedSettings)).isSymbolicLink()).toBe(true);
  });
});

describe('createClaudeSettingsGuard — per-config-root locking', () => {
  it('serializes concurrent acquisitions on the same config root', async () => {
    const configDir = await makeTempDir('claude-lock-');
    await writeFile(join(configDir, 'settings.json'), '{}', 'utf8');

    const guard = createClaudeSettingsGuard({ configDir, lockTimeoutMs: 2_000 });

    const first = await guard.acquire();

    let secondAcquired = false;
    const secondPromise = guard.acquire().then((session) => {
      secondAcquired = true;
      return session;
    });

    // The second acquisition must not resolve while the first holds the lock.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondAcquired).toBe(false);

    await first.restore();
    await first.release();

    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    await second.release();
  });
});
