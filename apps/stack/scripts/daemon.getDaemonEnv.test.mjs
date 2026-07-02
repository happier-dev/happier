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
  assert.equal(env.HAPPIER_DAEMON_STARTUP_SOURCE, 'manual');
});

test('getDaemonEnv preserves explicit active server id when its saved profile matches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-explicit-server-'));
  const serverUrl = 'http://127.0.0.1:3009';

  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        schemaVersion: 6,
        activeServerId: 'manual-profile',
        servers: {
          'manual-profile': {
            id: 'manual-profile',
            name: 'manual-profile',
            serverUrl,
            webappUrl: 'http://localhost:3009',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
          },
          'stack_main__id_default': {
            id: 'stack_main__id_default',
            name: 'stack_main__id_default',
            serverUrl,
            webappUrl: 'http://localhost:3009',
            createdAt: 2,
            updatedAt: 2,
            lastUsedAt: 2,
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  const env = getDaemonEnv({
    baseEnv: {},
    cliHomeDir: dir,
    internalServerUrl: serverUrl,
    publicServerUrl: serverUrl,
    stackName: 'main',
    cliIdentity: 'default',
  });

  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, 'stack_main__id_default');
});

test('getDaemonEnv marks service-mode starts as background-service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-service-'));

  const env = getDaemonEnv({
    baseEnv: {
      HAPPIER_STACK_SERVICE_MODE: '1',
    },
    cliHomeDir: dir,
    internalServerUrl: 'http://127.0.0.1:3009',
    publicServerUrl: 'http://127.0.0.1:3009',
    stackName: 'main',
    cliIdentity: 'default',
  });

  assert.equal(env.HAPPIER_DAEMON_STARTUP_SOURCE, 'background-service');
});

test('getDaemonEnv preserves an explicit startup source over service mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-explicit-'));

  const env = getDaemonEnv({
    baseEnv: {
      HAPPIER_STACK_SERVICE_MODE: '1',
      HAPPIER_DAEMON_STARTUP_SOURCE: 'self-restart',
    },
    cliHomeDir: dir,
    internalServerUrl: 'http://127.0.0.1:3009',
    publicServerUrl: 'http://127.0.0.1:3009',
    stackName: 'main',
    cliIdentity: 'default',
  });

  assert.equal(env.HAPPIER_DAEMON_STARTUP_SOURCE, 'self-restart');
});

test('getDaemonEnv preserves an explicit daemon service label', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-service-label-'));

  const env = getDaemonEnv({
    baseEnv: {
      HAPPIER_DAEMON_SERVICE_LABEL: 'happier-daemon.preview.example.service',
    },
    cliHomeDir: dir,
    internalServerUrl: 'http://127.0.0.1:3009',
    publicServerUrl: 'http://127.0.0.1:3009',
    stackName: 'main',
    cliIdentity: 'default',
  });

  assert.equal(env.HAPPIER_DAEMON_SERVICE_LABEL, 'happier-daemon.preview.example.service');
});
