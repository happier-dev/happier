import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withStackEnv } from './stack_environment.mjs';

async function withTempStackEnvFixture(fn) {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-env-sanitize-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'sanitize';
  const stackDir = join(storageDir, stackName);

  await mkdir(stackDir, { recursive: true });
  await writeFile(
    join(stackDir, 'env'),
    [
      'HAPPIER_STACK_REPO_DIR=/tmp/happier',
      `HAPPIER_STACK_CLI_HOME_DIR=${join(storageDir, stackName, 'cli')}`,
      'HAPPIER_STACK_SERVER_PORT=3555',
      '',
    ].join('\n'),
    'utf-8',
  );

  const previousStorageDir = process.env.HAPPIER_STACK_STORAGE_DIR;
  process.env.HAPPIER_STACK_STORAGE_DIR = storageDir;

  try {
    await fn({ stackName, storageDir });
  } finally {
    if (typeof previousStorageDir === 'undefined') {
      delete process.env.HAPPIER_STACK_STORAGE_DIR;
    } else {
      process.env.HAPPIER_STACK_STORAGE_DIR = previousStorageDir;
    }
    await rm(tmp, { recursive: true, force: true });
  }
}

test('withStackEnv clears leaked unprefixed server/home env vars from caller scope', async () => {
  await withTempStackEnvFixture(async ({ stackName }) => {
    const previousServerUrl = process.env.HAPPIER_SERVER_URL;
    const previousPublicServerUrl = process.env.HAPPIER_PUBLIC_SERVER_URL;
    const previousWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;

    process.env.HAPPIER_SERVER_URL = 'http://stale.localhost:9999';
    process.env.HAPPIER_PUBLIC_SERVER_URL = 'http://stale.localhost:9999';
    process.env.HAPPIER_WEBAPP_URL = 'http://stale.localhost:9999';
    process.env.HAPPIER_HOME_DIR = '/tmp/stale-home';

    try {
      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          assert.equal(env.HAPPIER_SERVER_URL, undefined);
          assert.equal(env.HAPPIER_PUBLIC_SERVER_URL, undefined);
          assert.equal(env.HAPPIER_WEBAPP_URL, undefined);
          assert.equal(env.HAPPIER_HOME_DIR, undefined);
        },
      });
    } finally {
      if (typeof previousServerUrl === 'undefined') delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = previousServerUrl;
      if (typeof previousPublicServerUrl === 'undefined') delete process.env.HAPPIER_PUBLIC_SERVER_URL;
      else process.env.HAPPIER_PUBLIC_SERVER_URL = previousPublicServerUrl;
      if (typeof previousWebappUrl === 'undefined') delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = previousWebappUrl;
      if (typeof previousHomeDir === 'undefined') delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = previousHomeDir;
    }
  });
});
