import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { applyClaudeSessionRetentionSettings } from './claudeSessionRetentionSettings';

describe('Claude local history retention', () => {
  it('writes Never to the provider file and preserves key order and permissions', () =>
    withTempDir('claude-local-history-', async root => {
      const path = join(root, 'settings.json');
      await writeFile(path, '{"theme":"dark","cleanupPeriodDays":30,"permissions":{"allow":["Read"]}}', { mode: 0o640 });
      const params = { configDir: root, id: 'native', policy: { mode: 'days', days: 36500 } as const };
      expect(await applyClaudeSessionRetentionSettings(params)).toMatchObject({ currentDays: 36500, status: 'applied' });
      const settings = await readFile(path, 'utf8');
      expect(settings).toBe(JSON.stringify({ theme: 'dark', cleanupPeriodDays: 36500,
        permissions: { allow: ['Read'] } }, null, 2) + '\n');
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o640);
    }));

  it('keeps invalid and managed settings bytes intact and returns only a fixed reason', () =>
    withTempDir('claude-local-history-', async root => {
      const configDir = join(root, 'config');
      const managedSettingsDir = join(root, 'managed');
      await mkdir(configDir);
      await mkdir(managedSettingsDir);
      const path = join(configDir, 'settings.json');
      const broken = '{"private-sentinel":';
      await writeFile(path, broken);
      const params = { configDir, id: 'native', policy: { mode: 'days', days: 36500 } as const };
      await expect(applyClaudeSessionRetentionSettings(params))
        .resolves.toMatchObject({ status: 'error', reason: 'invalid_settings' });
      expect(await readFile(path, 'utf8')).toBe(broken);
      const valid = '{"cleanupPeriodDays":30}';
      await writeFile(path, valid);
      await writeFile(join(managedSettingsDir, 'managed-settings.json'), '{"cleanupPeriodDays":15}');
      const direct = { ...params, managedSettingsDir };
      await expect(applyClaudeSessionRetentionSettings(direct))
        .resolves.toMatchObject({ status: 'managed', reason: 'managed_settings_detected' });
      expect(await readFile(path, 'utf8')).toBe(valid);
    }));
});
