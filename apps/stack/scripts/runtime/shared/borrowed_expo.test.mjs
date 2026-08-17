import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildBorrowedExpoUiUrl,
  isBorrowedExpoConsumer,
  projectBorrowedExpoRuntime,
  resolveBorrowedExpoLogPath,
  resolveBorrowedExpoRuntime,
} from './borrowed_expo.mjs';

async function resolveRemoteBorrowedExpoForTest(t, { metroRunning }) {
  const storageDir = await mkdirTempStackStorage(t);
  const producerStackName = 'repo-happier-producer';
  const producerStackDir = join(storageDir, producerStackName);
  await mkdir(producerStackDir, { recursive: true });
  await writeFile(
    join(producerStackDir, 'stack.runtime.json'),
    JSON.stringify({
      expo: { webPort: 19364, mobilePort: 19364, devClientEnabled: true },
      placement: { expo: 'mac' },
      remoteTargets: { mac: { status: 'running', services: { expo: true } } },
      processes: { expoPid: null },
    }) + '\n',
    'utf8',
  );

  const probedPorts = [];
  const projected = await resolveBorrowedExpoRuntime(
    {
      rootDir: process.cwd(),
      producerStackName,
      env: {
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_REPO_DIR: process.cwd(),
      },
    },
    {
      looksLikeExpoMetroImpl: async ({ port }) => {
        probedPorts.push(port);
        return metroRunning;
      },
    },
  );

  return { projected, probedPorts };
}

async function mkdirTempStackStorage(t) {
  const storageDir = await mkdtemp(join(tmpdir(), 'hstack-borrowed-expo-'));
  t.after(async () => await rm(storageDir, { recursive: true, force: true }));
  return storageDir;
}

test('isBorrowedExpoConsumer gives ownership only to a distinct producer stack', () => {
  assert.equal(isBorrowedExpoConsumer({ consumerStackName: 'qa', producerStackName: 'repo-dev' }), true);
  assert.equal(isBorrowedExpoConsumer({ consumerStackName: 'qa', producerStackName: 'qa' }), false);
  assert.equal(isBorrowedExpoConsumer({ consumerStackName: 'qa', producerStackName: '' }), false);
});

test('borrowed Expo rejects non-canonical producer names before resolving managed paths', async () => {
  assert.throws(
    () => isBorrowedExpoConsumer({ consumerStackName: 'qa', producerStackName: '../outside' }),
    /invalid borrowed Expo producer stack name/i,
  );
  await assert.rejects(
    () => resolveBorrowedExpoRuntime({
      rootDir: '/repo',
      producerStackName: 'My Stack',
      env: { HAPPIER_STACK_STORAGE_DIR: '/stacks' },
    }),
    /invalid borrowed Expo producer stack name/i,
  );
});

test('buildBorrowedExpoUiUrl routes the consumer origin to its own server with HMR disabled', () => {
  const url = new URL(buildBorrowedExpoUiUrl({
    consumerHost: 'happier-qa-agent-17.localhost',
    expoPort: 19364,
    serverPort: 53288,
  }));

  assert.equal(url.hostname, 'happier-qa-agent-17.localhost');
  assert.equal(url.port, '19364');
  assert.equal(url.searchParams.get('server'), 'http://happier-qa-agent-17.localhost:53288');
  assert.equal(url.searchParams.get('happier_hmr'), '0');
  assert.deepEqual(url.searchParams.getAll('happier_hmr'), ['0']);
});

test('borrowed Expo projects a verified running remote tunnel as a borrowed consumer endpoint', async (t) => {
  const { projected, probedPorts } = await resolveRemoteBorrowedExpoForTest(t, {
    metroRunning: true,
  });

  assert.deepEqual(projected, {
    producerStackName: 'repo-happier-producer',
    ownership: 'borrowed',
    running: true,
    status: 'running',
    port: 19364,
    mobilePort: 19364,
    devClientEnabled: true,
    source: 'remote_target',
    remoteTarget: 'mac',
  });
  assert.deepEqual(probedPorts, [19364]);
});

test('borrowed Expo does not report a remote producer running when its forwarded Metro endpoint is unavailable', async (t) => {
  const { projected, probedPorts } = await resolveRemoteBorrowedExpoForTest(t, {
    metroRunning: false,
  });

  assert.deepEqual(projected, {
    producerStackName: 'repo-happier-producer',
    ownership: 'borrowed',
    running: false,
    status: 'degraded',
    port: 19364,
    mobilePort: 19364,
    devClientEnabled: true,
    source: 'remote_target',
    remoteTarget: 'mac',
  });
  assert.deepEqual(probedPorts, [19364]);
});

test('borrowed Expo remains degraded after an owner process exit instead of claiming local fallback', () => {
  const projected = projectBorrowedExpoRuntime({
    producerStackName: 'repo-happier-producer',
    runtimeState: {
      expo: { webPort: null, mobilePort: null, devClientEnabled: true },
      placement: { expo: 'mac' },
      remoteTargets: { mac: { status: 'running', services: { expo: false } } },
      processes: { expoPid: null },
    },
    localEndpoint: null,
  });

  assert.equal(projected.ownership, 'borrowed');
  assert.equal(projected.running, false);
  assert.equal(projected.status, 'degraded');
  assert.equal(projected.source, 'remote_target');
  assert.equal(projected.remoteTarget, 'mac');
});

test('borrowed Expo log path follows the producer lifecycle owner', () => {
  assert.equal(
    resolveBorrowedExpoLogPath({ producerStackBaseDir: '/stacks/producer', remoteTarget: null }),
    '/stacks/producer/logs/expo.log',
  );
  assert.equal(
    resolveBorrowedExpoLogPath({ producerStackBaseDir: '/stacks/producer', remoteTarget: 'Second Mac' }),
    '/stacks/producer/logs/remote-second-mac.log',
  );
});
