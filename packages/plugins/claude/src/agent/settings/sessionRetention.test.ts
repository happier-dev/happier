import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { applyClaudeSessionRetentionSettings, readClaudeSessionRetentionPolicy } from './sessionRetention.js';

describe('Claude persistent session retention', () => {
  it('keeps unmanaged settings untouched and distinguishes an explicit provider reset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-retention-'));
    try {
      const path = join(root, 'settings.json');
      const original = '{"cleanupPeriodDays":7,"model":"sonnet"}\n';
      await writeFile(path, original);
      await expect(applyClaudeSessionRetentionSettings({ configDir: root, id: 'native', policy: null }))
        .resolves.toMatchObject({ status: 'unmanaged', currentDays: 7 });
      expect(await readFile(path, 'utf8')).toBe(original);
      await expect(applyClaudeSessionRetentionSettings({ configDir: root, id: 'native', policy: { mode: 'providerDefault' } }))
        .resolves.toMatchObject({ status: 'applied', currentDays: null });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ model: 'sonnet' });
      const missingHome = join(root, 'absent');
      await applyClaudeSessionRetentionSettings({ configDir: missingHome, id: 'absent', policy: null });
      await expect(lstat(missingHome)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(readClaudeSessionRetentionPolicy({})).toBeNull();
      expect(readClaudeSessionRetentionPolicy({ claudeSessionRetentionV1: { mode: 'days', days: 36500 } }))
        .toEqual({ mode: 'days', days: 36500 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes linked settings through their native authority and preserves permissions and unrelated keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-retention-linked-'));
    try {
      const native = join(root, 'native');
      const profile = join(root, 'profile');
      await mkdir(native);
      await mkdir(profile);
      const path = join(native, 'settings.json');
      await writeFile(path, '{"cleanupPeriodDays":7,"model":"sonnet"}');
      await chmod(path, 0o640);
      await symlink(path, join(profile, 'settings.json'));
      await expect(applyClaudeSessionRetentionSettings({ configDir: profile, id: 'profile', policy: { mode: 'days', days: 36500 } }))
        .resolves.toMatchObject({ status: 'applied', currentDays: 36500 });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ cleanupPeriodDays: 36500, model: 'sonnet' });
      expect((await lstat(join(profile, 'settings.json'))).isSymbolicLink()).toBe(true);
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o640);
      const before = await stat(path);
      await applyClaudeSessionRetentionSettings({ configDir: profile, id: 'profile', policy: { mode: 'days', days: 36500 } });
      expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports malformed and dangling linked settings without replacing them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-retention-invalid-'));
    try {
      const path = join(root, 'settings.json');
      await writeFile(path, '{invalid');
      const policy = { mode: 'days', days: 365 } as const;
      await expect(applyClaudeSessionRetentionSettings({ configDir: root, id: 'native', policy }))
        .resolves.toMatchObject({ status: 'error', reason: 'invalid_settings' });
      expect(await readFile(path, 'utf8')).toBe('{invalid');
      await rm(path);
      await symlink(join(root, 'missing', 'settings.json'), path);
      await expect(applyClaudeSessionRetentionSettings({ configDir: root, id: 'native', policy }))
        .resolves.toMatchObject({ status: 'error', reason: 'settings_write_failed' });
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
