import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { applyClaudeAccountSettings } from './applyAccountSettings.js';

describe('Claude account settings application', () => {
  it('warns about an actionable error without exposing directories or policy values and keeps unmanaged applications quiet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-account-retention-warning-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const directory = join(root, 'private-home');
      await mkdir(directory);
      await writeFile(join(directory, 'settings.json'), '{');
      const targets = [{ id: 'admitted-home', directory }];
      await applyClaudeAccountSettings({ pluginSettings: { account: {} }, targets }, join(root, 'system'));
      expect(warn).not.toHaveBeenCalled();
      const report = await applyClaudeAccountSettings({
        pluginSettings: { account: { claudeSessionRetentionV1: { mode: 'days', days: 36500 } } }, targets,
      }, join(root, 'system'));
      expect(report.targets).toEqual([{ id: 'admitted-home', status: 'error', currentDays: null, reason: 'invalid_settings' }]);
      expect(warn.mock.calls).toEqual([
        ['[claude] Local session retention could not be applied', { targetId: 'admitted-home', reason: 'invalid_settings' }],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(root);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('36500');
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies the Account plugin policy to every admitted home and reports administrative conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-account-retention-'));
    try {
      const native = join(root, 'native');
      const profile = join(root, 'profile');
      const system = join(root, 'system');
      await mkdir(native);
      await mkdir(profile);
      await mkdir(system);
      await writeFile(join(native, 'settings.json'), '{"model":"sonnet","cleanupPeriodDays":7}');
      const input = {
        pluginSettings: { account: { claudeSessionRetentionV1: { mode: 'days', days: 365 } } },
        targets: [{ id: 'native', directory: native }, { id: 'profile', directory: profile }],
      } as const;
      expect(await applyClaudeAccountSettings(input, system)).toEqual({
        policy: { mode: 'days', days: 365 },
        targets: [
          { id: 'native', status: 'applied', currentDays: 365 },
          { id: 'profile', status: 'applied', currentDays: 365 },
        ],
      });
      expect(JSON.parse(await readFile(join(native, 'settings.json'), 'utf8')))
        .toEqual({ model: 'sonnet', cleanupPeriodDays: 365 });
      expect(JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'))).toEqual({ cleanupPeriodDays: 365 });
      await writeFile(join(system, 'managed-settings.json'), '{"cleanupPeriodDays":7}');
      expect((await applyClaudeAccountSettings(input, system)).targets)
        .toEqual(input.targets.map(({ id }) => ({ id, status: 'managed', currentDays: 365, reason: 'managed_settings_detected' })));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
