import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  renderWindowsRemoteUpdateRegistration,
  renderWindowsRemoteUpdateRunner,
  spawnWindowsRemoteCliUpdate,
} from './windowsRemoteCliUpdate';

describe('Windows remote CLI update', () => {
  it('runs the updater as a scheduled task and reports admission from a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-win-update-'));
    try {
      const logPath = join(dir, 'cli-update.log');
      const started = spawnWindowsRemoteCliUpdate({
        script: join(dir, 'happier.exe'),
        args: ['self', 'update'],
        cwd: dir,
        env: { HAPPIER_HOME_DIR: dir },
        logPath,
      }, {
        execPath: join(dir, 'happier.exe'),
        runRegistration: (scriptPath) => {
          const registration = readFileSync(scriptPath, 'utf8');
          expect(registration).toContain("TaskName 'happier-cli-remote-update'");
          expect(registration).toContain('schtasks.exe /Run');
          const runner = readFileSync(`${logPath}.run.ps1`, 'utf8');
          expect(runner).toContain('--admission-path');
          expect(runner).toContain(dir);
          expect(runner).not.toContain('taskkill');
          return 0;
        },
      });
      expect(started.started).toBe(true);
      writeFileSync(`${logPath}.admission.json`, '{"admitted":true}\n');
      const { readUpdaterAdmission } = await import('./updaterAdmission');
      await expect(readUpdaterAdmission(started.admission!)).resolves.toEqual({ admitted: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to start when the task cannot be registered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-win-update-fail-'));
    try {
      const result = spawnWindowsRemoteCliUpdate({
        script: 'happier.exe',
        args: ['self', 'update', '--preview'],
        cwd: dir,
        env: {},
        logPath: join(dir, 'cli-update.log'),
      }, { execPath: 'happier.exe', runRegistration: () => 1 });
      expect(result).toEqual({ started: false, admission: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the runner outside the daemon process tree', () => {
    const runner = renderWindowsRemoteUpdateRunner({
      file: 'C:\\Users\\u\\.happier\\bin\\happier.exe',
      args: ['self', 'update', '--admission-path', 'C:\\Users\\u\\.happier\\logs\\cli-update.log.admission.json'],
      cwd: 'C:\\Users\\u',
      logPath: 'C:\\Users\\u\\.happier\\logs\\cli-update.log',
      admissionPath: 'C:\\Users\\u\\.happier\\logs\\cli-update.log.admission.json',
      homeDir: 'C:\\Users\\u\\.happier',
    });
    const registration = renderWindowsRemoteUpdateRegistration({ runnerPath: 'C:\\Users\\u\\.happier\\logs\\cli-update.log.run.ps1' });
    expect(registration).toContain('Register-ScheduledTask');
    expect(registration).toContain('LogonType Interactive');
    expect(runner).toContain("$env:HAPPIER_HOME_DIR = 'C:\\Users\\u\\.happier'");
    expect(runner).toContain('updater exited before admission');
  });
});
