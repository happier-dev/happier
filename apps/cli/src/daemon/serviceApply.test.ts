import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import type { DaemonServiceInstallPlan, DaemonServiceUninstallPlan } from './service/plan';
import { applyDaemonServiceInstallPlan, applyDaemonServiceUninstallPlan } from './service/apply';

describe('daemon service apply', () => {
  it('writes planned install files with declared modes (without running commands)', async () => {
    const userHomeDir = await mkdtemp(join(tmpdir(), 'happier-service-home-'));
    const unitPath = join(userHomeDir, '.config', 'systemd', 'user', 'happier-daemon.cloud.service');
    const unitContent = [
      '[Unit]',
      'Description=Happier daemon',
      '[Service]',
      'ExecStart=/usr/bin/node /opt/happier/dist/index.mjs daemon start-sync',
      '',
    ].join('\n');

    try {
      const plan: DaemonServiceInstallPlan = {
        platform: 'linux',
        files: [{ path: unitPath, content: unitContent, mode: 0o640 }],
        commands: [{ cmd: 'systemctl', args: ['--user', 'daemon-reload'] }],
      };

      await applyDaemonServiceInstallPlan(plan, { runCommands: false });

      expect(existsSync(unitPath)).toBe(true);

      const content = await readFile(unitPath, 'utf-8');
      expect(content).toBe(unitContent);

      const s = await stat(unitPath);
      expect(s.mode & 0o777).toBe(0o640);
    } finally {
      await rm(userHomeDir, { recursive: true, force: true });
    }
  });

  it('removes only planned uninstall files (without running commands)', async () => {
    const userHomeDir = await mkdtemp(join(tmpdir(), 'happier-service-home-'));
    const removablePath = join(userHomeDir, '.config', 'systemd', 'user', 'happier-daemon.cloud.service');
    const keepPath = join(userHomeDir, '.config', 'systemd', 'user', 'keep.service');

    try {
      await mkdir(join(userHomeDir, '.config', 'systemd', 'user'), { recursive: true });
      await writeFile(removablePath, '[Unit]\nDescription=remove me\n', 'utf-8');
      await writeFile(keepPath, '[Unit]\nDescription=keep me\n', 'utf-8');

      const uninstallPlan: DaemonServiceUninstallPlan = {
        platform: 'linux',
        filesToRemove: [removablePath, join(userHomeDir, '.config', 'systemd', 'user', 'missing.service')],
        commands: [{ cmd: 'systemctl', args: ['--user', 'disable', '--now', 'happier-daemon.cloud.service'] }],
      };
      await applyDaemonServiceUninstallPlan(uninstallPlan, { runCommands: false });

      expect(existsSync(removablePath)).toBe(false);
      expect(existsSync(keepPath)).toBe(true);
    } finally {
      await rm(userHomeDir, { recursive: true, force: true });
    }
  });
});
