import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: cli profiles list', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop().catch(() => {});
    server = null;
  });

  it('lists built-in + custom profiles from account settings', async () => {
    const testDir = run.testDir(`cli-profiles-list-${randomUUID()}`);
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
      },
    });
    const auth = await createTestAuth(server.baseUrl);

    const v2get = await fetchJson<any>(`${server.baseUrl}/v2/account/settings`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(v2get.status).toBe(200);
    const currentVersion = typeof v2get.data?.version === 'number' ? v2get.data.version : 0;

    const settings = {
      schemaVersion: 6,
      useProfiles: true,
      profiles: [
        {
          id: 'work',
          name: 'Work',
          environmentVariables: [{ name: 'WORK_BASE_URL', value: 'https://example.com' }],
          envVarRequirements: [
            { name: 'WORK_TOKEN', kind: 'secret', required: true },
            { name: 'WORK_HOST', kind: 'config', required: true },
          ],
        },
      ],
    };

    const v2post = await fetchJson<any>(`${server.baseUrl}/v2/account/settings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: currentVersion,
        content: { t: 'plain', v: settings },
      }),
      timeoutMs: 15_000,
    });
    if (v2post.status !== 200) {
      throw new Error(`Unexpected POST /v2/account/settings response (status=${v2post.status}): ${JSON.stringify(v2post.data)}`);
    }
    expect(v2post.data?.success).toBe(true);

    const cliHome = resolve(join(testDir, 'cli-home'));
    await mkdir(cliHome, { recursive: true });
    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: server.baseUrl, token: auth.token, secret });

    const cliEnvelope = await runCliJson({
      testDir,
      cliHomeDir: cliHome,
      serverUrl: server.baseUrl,
      webappUrl: server.baseUrl,
      env: { ...process.env, CI: '1', HAPPIER_VARIANT: 'dev' },
      label: 'profiles.list',
      args: ['profiles', 'list', '--refresh-settings', '--json'],
      timeoutMs: 120_000,
    });

    expect(cliEnvelope.ok).toBe(true);
    expect(cliEnvelope.kind).toBe('profiles_list');

    const data = cliEnvelope.data as any;
    expect(data?.authenticated).toBe(true);
    expect(data?.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'anthropic', isBuiltIn: true }),
        expect.objectContaining({
          id: 'work',
          isBuiltIn: false,
          requiredSecretEnvVarNames: expect.arrayContaining(['WORK_TOKEN']),
          requiredConfigEnvVarNames: expect.arrayContaining(['WORK_HOST']),
        }),
      ]),
    );
  }, 240_000);
});
