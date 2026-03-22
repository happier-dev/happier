import { describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

import { handleServerCommand } from './server';

const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL'] as const;
let envScope = createEnvKeyScope(envKeys);

describe('happier server add', () => {
  it('prints follow-up daemon commands in non-interactive mode when --use is set', async () => {
    const home = await createTempDir('happier-server-add-');
    const output = captureConsoleLogAndMuteStdout();

    try {
      process.env.HAPPIER_HOME_DIR = home;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      reloadConfiguration();

      await handleServerCommand([
        'add',
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
      expect(out).toContain('daemon service install');
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
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      reloadConfiguration();

      await handleServerCommand([
        'add',
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
      expect(out).toContain('daemon service install');
    } finally {
      output.restore();
      envScope.restore();
      envScope = createEnvKeyScope(envKeys);
      reloadConfiguration();
      await removeTempDir(home);
    }
  });
});
