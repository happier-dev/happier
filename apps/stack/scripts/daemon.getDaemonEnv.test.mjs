import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getDaemonEnv } from './daemon.mjs';
import { buildStackStableScopeId } from './utils/auth/stable_scope_id.mjs';

test('getDaemonEnv keeps machine identity and lifecycle state on the stable stack scope', async () => {
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

  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, stableScopeId);
  assert.equal(env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID, stableScopeId);
  assert.equal(env.HAPPIER_DAEMON_STARTUP_SOURCE, 'manual');
});

test('getDaemonEnv seeds stack ownership env from the resolved stack name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-stack-'));

  const env = getDaemonEnv({
    baseEnv: {
      HAPPIER_STACK_PROCESS_KIND: 'session',
    },
    cliHomeDir: dir,
    internalServerUrl: 'http://127.0.0.1:3009',
    publicServerUrl: 'http://127.0.0.1:3009',
    stackName: 'dev',
    cliIdentity: 'default',
  });

  assert.equal(env.HAPPIER_STACK_STACK, 'dev');
  assert.equal(env.HAPPIER_STACK_PROCESS_KIND, 'daemon');
});

test('getDaemonEnv preserves a matching explicit active server id when settings profiles share the URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stack-daemon-env-explicit-'));
  const serverUrl = 'http://127.0.0.1:52753';
  const defaultServerId = 'stack_repo-remote-dev-d72117acdb__id_default';
  const explicitServerId = 'android-keyboard-qa';

  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        schemaVersion: 6,
        activeServerId: defaultServerId,
        servers: {
          [defaultServerId]: {
            id: defaultServerId,
            name: 'Default',
            serverUrl,
            localServerUrl: serverUrl,
            webappUrl: 'http://localhost:52753',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
          },
          [explicitServerId]: {
            id: explicitServerId,
            name: 'Android keyboard QA',
            serverUrl: 'http://10.0.2.2:52753',
            localServerUrl: serverUrl,
            webappUrl: 'http://10.0.2.2:52753',
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

  const env = getDaemonEnv({
    baseEnv: { HAPPIER_ACTIVE_SERVER_ID: explicitServerId },
    cliHomeDir: dir,
    internalServerUrl: serverUrl,
    publicServerUrl: 'http://localhost:52753',
  });

  assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, explicitServerId);
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
