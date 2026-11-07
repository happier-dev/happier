import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat, lstat, utimes, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createClaudeSettingsGuard,
  getClaudeSettingsGuardInProcessLockCountForTesting,
  resolveClaudeConfigRootFromEnv,
  resolveClaudeSettingsFilePath,
  withClaudeSettingsWriteLock,
} from './settingsGuard';

const tempRoots: string[] = [];
const lockDirName = '.happier-tui-control.lock';
const journalFileName = 'settings-journal.json';

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeStaleJournal(
  configDir: string,
  files: readonly Readonly<{
    relPath: string;
    absPath: string;
    existedBefore: boolean;
    isSymlink: boolean;
    resolvedPath: string;
    content: string | null;
  }>[],
): Promise<void> {
  const lockDir = join(configDir, lockDirName);
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, journalFileName), JSON.stringify({
    version: 1,
    files: files.map((file) => ({
      relPath: file.relPath,
      absPath: file.absPath,
      existedBefore: file.existedBefore,
      isSymlink: file.isSymlink,
      resolvedPath: file.resolvedPath,
      contentBase64: file.content === null ? null : Buffer.from(file.content).toString('base64'),
    })),
  }), 'utf8');
  await utimes(lockDir, new Date(0), new Date(0));
}

describe('resolveClaudeConfigRootFromEnv', () => {
  it('prefers an explicit CLAUDE_CONFIG_DIR over the real home', () => {
    expect(resolveClaudeConfigRootFromEnv({ CLAUDE_CONFIG_DIR: '/srv/profile/claude', HOME: '/home/u' }, 'linux'))
      .toBe('/srv/profile/claude');
  });

  it('falls back to ~/.claude in a no-profile real-home session', () => {
    expect(resolveClaudeConfigRootFromEnv({ HOME: '/home/u' }, 'linux')).toBe('/home/u/.claude');
  });

  it('preserves the explicit platform when resolving a Windows home', () => {
    expect(resolveClaudeConfigRootFromEnv({ USERPROFILE: '/windows/u', HOME: '/other' }, 'win32'))
      .toBe('/windows/u/.claude');
  });
});

describe('resolveClaudeSettingsFilePath', () => {
  it('rejects a dangling settings link without replacing it', async () => {
    const configDir = await makeTempDir('claude-dangling-settings-');
    const settingsPath = join(configDir, 'settings.json');
    await symlink(join(configDir, 'missing.json'), settingsPath);

    await expect(resolveClaudeSettingsFilePath(configDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
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

describe('createClaudeSettingsGuard — stale durable journal recovery', () => {
  it('restores bytes from a stale journal before taking the next snapshot', async () => {
    const configDir = await makeTempDir('claude-journal-bytes-');
    const settingsPath = join(configDir, 'settings.json');
    const original = JSON.stringify({ statusLine: { type: 'command' } }, null, 2);
    await writeFile(settingsPath, JSON.stringify({ statusLine: { type: 'command' }, model: 'sonnet' }, null, 2), 'utf8');
    await writeStaleJournal(configDir, [{
      relPath: 'settings.json',
      absPath: settingsPath,
      existedBefore: true,
      isSymlink: false,
      resolvedPath: settingsPath,
      content: original,
    }]);

    const guard = createClaudeSettingsGuard({
      configDir,
      nowMs: () => 10_000,
      lockStaleMs: 1,
      wait: async () => undefined,
    });
    const session = await guard.acquire();

    expect(await readFile(settingsPath, 'utf8')).toBe(original);
    expect(session.snapshot.find((file) => file.relPath === 'settings.json')?.content?.toString('utf8')).toBe(original);

    const restore = await session.restore();
    await session.release();

    expect(restore.ok).toBe(true);
    await expect(stat(join(configDir, lockDirName))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a file created after a stale journal recorded original absence', async () => {
    const configDir = await makeTempDir('claude-journal-created-');
    const settingsPath = join(configDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ model: 'sonnet' }), 'utf8');
    await writeStaleJournal(configDir, [{
      relPath: 'settings.json',
      absPath: settingsPath,
      existedBefore: false,
      isSymlink: false,
      resolvedPath: settingsPath,
      content: null,
    }]);

    const guard = createClaudeSettingsGuard({
      configDir,
      nowMs: () => 10_000,
      lockStaleMs: 1,
      wait: async () => undefined,
    });
    const session = await guard.acquire();

    await expect(stat(settingsPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(session.snapshot.find((file) => file.relPath === 'settings.json')?.existedBefore).toBe(false);

    await session.release();
    await expect(stat(join(configDir, lockDirName))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores the resolved target for symlinked settings from a stale journal', async () => {
    const realHome = await makeTempDir('claude-journal-realhome-');
    const realClaude = join(realHome, '.claude');
    await mkdir(realClaude, { recursive: true });
    const realSettings = join(realClaude, 'settings.json');
    const original = JSON.stringify({ theme: 'dark' }, null, 2);
    await writeFile(realSettings, JSON.stringify({ theme: 'dark', model: 'sonnet' }, null, 2), 'utf8');

    const linkedConfigDir = await makeTempDir('claude-journal-linked-');
    const linkedSettings = join(linkedConfigDir, 'settings.json');
    await symlink(realSettings, linkedSettings);
    await writeStaleJournal(linkedConfigDir, [{
      relPath: 'settings.json',
      absPath: linkedSettings,
      existedBefore: true,
      isSymlink: true,
      resolvedPath: realSettings,
      content: original,
    }]);

    const guard = createClaudeSettingsGuard({
      configDir: linkedConfigDir,
      nowMs: () => 10_000,
      lockStaleMs: 1,
      wait: async () => undefined,
    });
    const session = await guard.acquire();

    expect(await readFile(realSettings, 'utf8')).toBe(original);
    expect((await lstat(linkedSettings)).isSymbolicLink()).toBe(true);
    expect(session.snapshot.find((file) => file.relPath === 'settings.json')?.resolvedPath).toBe(await realpath(realSettings));

    await session.release();
    await expect(stat(join(linkedConfigDir, lockDirName))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('createClaudeSettingsGuard — per-config-root locking', () => {
  it('respects the native filesystem lock when entering through a linked profile', async () => {
    const nativeDir = await makeTempDir('claude-native-disk-lock-');
    const profileDir = await makeTempDir('claude-profile-disk-lock-');
    await writeFile(join(nativeDir, 'settings.json'), '{}', 'utf8');
    await symlink(join(nativeDir, 'settings.json'), join(profileDir, 'settings.json'));
    await mkdir(join(nativeDir, lockDirName));
    let nowMs = 0;

    const guard = createClaudeSettingsGuard({
      configDir: profileDir,
      nowMs: () => nowMs,
      wait: async () => { nowMs += 1; },
      lockTimeoutMs: 1,
    });

    await expect(guard.acquire()).rejects.toThrow('timed out acquiring Claude settings lock');
    await expect(stat(join(profileDir, lockDirName))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes a linked profile with the native settings owner', async () => {
    const nativeDir = await makeTempDir('claude-native-lock-');
    const profileDir = await makeTempDir('claude-profile-lock-');
    await writeFile(join(nativeDir, 'settings.json'), '{}', 'utf8');
    await symlink(join(nativeDir, 'settings.json'), join(profileDir, 'settings.json'));

    const first = await createClaudeSettingsGuard({ configDir: profileDir }).acquire();
    let secondAcquired = false;
    const secondPromise = createClaudeSettingsGuard({ configDir: nativeDir }).acquire().then((session) => {
      secondAcquired = true;
      return session;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(secondAcquired).toBe(false);
    } finally {
      await first.restore();
      await first.release();
      await (await secondPromise).release();
    }
  });

  it('removes idle in-process lock entries after release', async () => {
    const configDir = await makeTempDir('claude-lock-cleanup-');
    const guard = createClaudeSettingsGuard({ configDir });
    const session = await guard.acquire();

    await session.release();
    await Promise.resolve();

    expect(getClaudeSettingsGuardInProcessLockCountForTesting()).toBe(0);
  });

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

describe('withClaudeSettingsWriteLock', () => {
  it('writes after linked-profile restoration and retains the update through the next control', async () => {
    const nativeDir = await makeTempDir('claude-native-write-');
    const profileDir = await makeTempDir('claude-profile-write-');
    const settingsPath = join(nativeDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ theme: 'dark' }), 'utf8');
    await symlink(settingsPath, join(profileDir, 'settings.json'));
    const guard = createClaudeSettingsGuard({ configDir: profileDir });
    const first = await guard.acquire();
    await writeFile(settingsPath, JSON.stringify({ theme: 'dark', model: 'sonnet' }), 'utf8');
    let writerStarted = false;
    const write = withClaudeSettingsWriteLock(nativeDir, async () => {
      writerStarted = true;
      const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
      expect(settings).toEqual({ theme: 'dark' });
      await writeFile(settingsPath, JSON.stringify({ ...settings, cleanupPeriodDays: 365 }), 'utf8');
      return 'saved';
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(writerStarted).toBe(false);
    } finally {
      await first.restore();
      await first.release();
    }
    await expect(write).resolves.toBe('saved');

    const next = await guard.acquire();
    await writeFile(settingsPath, JSON.stringify({ model: 'opus' }), 'utf8');
    expect(await next.restore()).toEqual({ ok: true });
    await next.release();

    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ theme: 'dark', cleanupPeriodDays: 365 });
  });

  it('releases on writer failure and does not roll its intended write back through stale recovery', async () => {
    const nativeDir = await makeTempDir('claude-native-write-recovery-');
    const profileDir = await makeTempDir('claude-profile-write-recovery-');
    const settingsPath = join(nativeDir, 'settings.json');
    await writeFile(settingsPath, '{}', 'utf8');
    await symlink(settingsPath, join(profileDir, 'settings.json'));
    const lockDir = join(nativeDir, lockDirName);
    let journal = '';

    await expect(withClaudeSettingsWriteLock(nativeDir, async () => {
      journal = await readFile(join(lockDir, journalFileName), 'utf8');
      await writeFile(settingsPath, JSON.stringify({ cleanupPeriodDays: 365 }), 'utf8');
      throw new Error('writer failed after saving');
    })).rejects.toThrow('writer failed after saving');
    await expect(stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });

    // Replay the writer's actual journal as if its process stopped before releasing the lock.
    await mkdir(lockDir);
    await writeFile(join(lockDir, journalFileName), journal, 'utf8');
    await utimes(lockDir, new Date(0), new Date(0));
    const recovered = await createClaudeSettingsGuard({
      configDir: profileDir,
      nowMs: () => 10_000,
      lockStaleMs: 1,
    }).acquire();
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ cleanupPeriodDays: 365 });
    await recovered.restore();
    await recovered.release();
    expect((await lstat(join(profileDir, 'settings.json'))).isSymbolicLink()).toBe(true);
  });

  it('fails closed on an unreadable legacy profile journal and releases the shared target lock', async () => {
    const nativeDir = await makeTempDir('claude-native-invalid-journal-');
    const profileDir = await makeTempDir('claude-profile-invalid-journal-');
    await writeFile(join(nativeDir, 'settings.json'), '{}', 'utf8');
    await symlink(join(nativeDir, 'settings.json'), join(profileDir, 'settings.json'));
    const legacyLockDir = join(profileDir, lockDirName);
    await mkdir(legacyLockDir);
    await writeFile(join(legacyLockDir, journalFileName), '{invalid', 'utf8');
    await utimes(legacyLockDir, new Date(0), new Date(0));

    await expect(withClaudeSettingsWriteLock(profileDir, async () => undefined))
      .rejects.toThrow('failed to parse stale settings journal');
    await expect(stat(join(nativeDir, lockDirName))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(legacyLockDir, journalFileName), 'utf8')).toBe('{invalid');
  });
});
