import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

import { handleProvidersCommand } from './providers';

describe('happier providers --json', () => {
  let home = '';
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);

  beforeEach(async () => {
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    home = await createTempDir('happier-providers-json-');
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();
  });

  afterEach(async () => {
    envScope.restore();
    reloadConfiguration();
    if (home) await removeTempDir(home);
  });

  it('prints a providers_list JSON envelope', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleProvidersCommand(['list', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('providers_list');
      expect(Array.isArray(parsed.data?.providers)).toBe(true);
      expect(parsed.data.providers.length).toBeGreaterThan(0);
      const first = parsed.data.providers[0];
      expect(first).toEqual(expect.objectContaining({
        id: expect.any(String),
        title: expect.any(String),
        installed: expect.any(Boolean),
      }));
      expect(first.source === null || typeof first.source === 'string').toBe(true);
      expect(first.command === null || typeof first.command === 'string').toBe(true);
    } finally {
      output.restore();
    }
  });
});
