import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getDaemonEnv } from './daemon.mjs';
import { buildStackStableScopeId } from './utils/auth/stable_scope_id.mjs';

test('getDaemonEnv prefers the matching cli settings server id over the stable scope id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-'));
  const serverUrl = 'http://127.0.0.1:3009';
  const canonicalServerId = 'stack-qa-server';

  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        schemaVersion: 6,
        activeServerId: canonicalServerId,
        servers: {
          [canonicalServerId]: {
            id: canonicalServerId,
            name: canonicalServerId,
            serverUrl,
            webappUrl: 'http://localhost:3009',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  const stableScopeId = buildStackStableScopeId({ stackName: 'main', cliIdentity: 'default' });
  assert.notEqual(stableScopeId, canonicalServerId);

  const env = getDaemonEnv({
    baseEnv: {},
    cliHomeDir: dir,
    internalServerUrl: serverUrl,
    publicServerUrl: serverUrl,
    stackName: 'main',
    cliIdentity: 'default',
  });

  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, canonicalServerId);
});

