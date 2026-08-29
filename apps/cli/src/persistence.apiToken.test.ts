import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { reloadConfiguration, configuration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const SYNTHETIC_API_TOKEN = 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43);

const envKeys = [
  'HAPPIER_HOME_DIR',
  'HAPPIER_TOKEN',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
] as const;

let envScope = createEnvKeyScope(envKeys);

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  reloadConfiguration();
  vi.restoreAllMocks();
});

async function writeStoredToken(token: string): Promise<string> {
  await mkdir(dirname(configuration.privateKeyFile), { recursive: true });
  const serialized = JSON.stringify({ token }, null, 2);
  await writeFile(configuration.privateKeyFile, serialized, 'utf8');
  return serialized;
}

describe('readStoredCredentials API Token selection', () => {
  it('uses HAPPIER_TOKEN for this invocation without rewriting the stored credential', async () => {
    await withTempDir('happier-cli-api-token-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_TOKEN: SYNTHETIC_API_TOKEN,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });
      reloadConfiguration();
      const stored = await writeStoredToken('stored-session-bearer');

      const { readStoredCredentials } = await import('./persistence');

      await expect(readStoredCredentials()).resolves.toEqual({
        token: SYNTHETIC_API_TOKEN,
        encryption: null,
        credentialProvenance: 'api_token',
      });
      await expect(readFile(configuration.privateKeyFile, 'utf8')).resolves.toBe(stored);
    });
  });

  it('keeps the saved bearer credential when no API Token is supplied', async () => {
    await withTempDir('happier-cli-api-token-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_TOKEN: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });
      reloadConfiguration();
      await writeStoredToken('stored-session-bearer');

      const { readStoredCredentials } = await import('./persistence');

      await expect(readStoredCredentials()).resolves.toEqual({
        token: 'stored-session-bearer',
        encryption: null,
        credentialProvenance: 'stored_session',
      });
    });
  });
});
