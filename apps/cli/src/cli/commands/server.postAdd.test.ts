import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';
import { describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

import { handleServerCommand } from './server';

const envKeys = [
  'HAPPIER_HOME_DIR',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_ACTIVE_SERVER_ID',
] as const;

let envScope = createEnvKeyScope(envKeys);

function writeInstalledDefaultFollowingServiceFixture(homeDir: string, happierHomeDir: string): void {
  const installedPath = join(homeDir, '.config', 'systemd', 'user', 'happier-daemon.default.service');
  mkdirSync(dirname(installedPath), { recursive: true });
  writeFileSync(
    installedPath,
    renderSystemdServiceUnit({
      description: 'Happier CLI daemon (default)',
      execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
      env: {
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
        HAPPIER_HOME_DIR: happierHomeDir,
      },
      wantedBy: 'default.target',
    }),
    'utf-8',
  );
}

describe('happier server add', () => {
  it('prints follow-up daemon commands in non-interactive mode when --use is set', async () => {
    const home = await createTempDir('happier-server-add-');
    const output = captureConsoleLogAndMuteStdout();

    try {
      process.env.HAPPIER_HOME_DIR = home;
      delete process.env.HAPPIER_ACTIVE_SERVER_ID;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--yes',
        '--name',
        'Company',
        '--server-url',
        'https://company.example.test',
        '--webapp-url',
        'https://company.example.test',
        '--use',
      ]);

      const out = output.logs.join('\n');
      expect(out).toContain('happier --server');
      expect(out).toContain('daemon start');
      expect(out).toContain('service install');
      expect(out).not.toContain('daemon service install');
    } finally {
      output.restore();
      envScope.restore();
      envScope = createEnvKeyScope(envKeys);
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('prints follow-up daemon commands in non-interactive mode even when --use is not set', async () => {
    const home = await createTempDir('happier-server-add-no-use-');
    const output = captureConsoleLogAndMuteStdout();

    try {
      process.env.HAPPIER_HOME_DIR = home;
      delete process.env.HAPPIER_ACTIVE_SERVER_ID;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--yes',
        '--name',
        'Company',
        '--server-url',
        'https://company.example.test',
        '--webapp-url',
        'https://company.example.test',
      ]);

      const out = output.logs.join('\n');
      expect(out).toContain('Next steps');
      expect(out).toContain('happier --server');
      expect(out).toContain('daemon start');
      expect(out).toContain('service install');
      expect(out).not.toContain('daemon service install');
    } finally {
      output.restore();
      envScope.restore();
      envScope = createEnvKeyScope(envKeys);
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('guides to restart a default-following background service after adding and using a new server', async () => {
    const home = await createTempDir('happier-server-add-use-followup-');
    const happierHomeDir = join(home, '.happier');
    const output = captureConsoleLogAndMuteStdout();

    try {
      process.env.HAPPIER_HOME_DIR = happierHomeDir;
      process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = 'linux';
      process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = home;
      process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = happierHomeDir;
      delete process.env.HAPPIER_ACTIVE_SERVER_ID;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      writeInstalledDefaultFollowingServiceFixture(home, happierHomeDir);
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--yes',
        '--name',
        'Company',
        '--server-url',
        'https://company.example.test',
        '--webapp-url',
        'https://company.example.test',
        '--use',
      ]);

      const out = output.logs.join('\n');
      expect(out).toContain('Authenticate Happier against https://company.example.test');
      expect(out).toContain('happier auth login');
      expect(out).toContain('happier service restart');
      expect(out).not.toContain('daemon service restart');
    } finally {
      output.restore();
      envScope.restore();
      envScope = createEnvKeyScope(envKeys);
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('guides to restart a default-following background service after switching the active server', async () => {
    const home = await createTempDir('happier-server-use-followup-');
    const happierHomeDir = join(home, '.happier');
    const output = captureConsoleLogAndMuteStdout();

    try {
      process.env.HAPPIER_HOME_DIR = happierHomeDir;
      process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = 'linux';
      process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = home;
      process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = happierHomeDir;
      delete process.env.HAPPIER_ACTIVE_SERVER_ID;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      writeInstalledDefaultFollowingServiceFixture(home, happierHomeDir);
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--yes',
        '--name',
        'Alpha',
        '--server-url',
        'https://alpha.example.test',
        '--webapp-url',
        'https://alpha.example.test',
      ]);
      await handleServerCommand([
        'add',
        '--yes',
        '--name',
        'Beta',
        '--server-url',
        'https://beta.example.test',
        '--webapp-url',
        'https://beta.example.test',
      ]);
      output.logs.length = 0;

      await handleServerCommand(['use', 'Beta']);

      const out = output.logs.join('\n');
      expect(out).toContain('Authenticate Happier against https://beta.example.test');
      expect(out).toContain('happier auth login');
      expect(out).toContain('happier service restart');
      expect(out).not.toContain('daemon service restart');
    } finally {
      output.restore();
      envScope.restore();
      envScope = createEnvKeyScope(envKeys);
      reloadConfiguration();
      await removeTempDir(home);
    }
  });
});
