import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import { runNode } from './testkit/runtime_snapshot_testkit.mjs';

const stackRootDir = join(import.meta.dirname, '..');
const runScript = join(stackRootDir, 'scripts', 'run.mjs');

function isolatedEnv(overrides = {}) {
  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: 'provider-start-test',
    HAPPIER_STACK_ENV_FILE: join(import.meta.dirname, 'nonexistent-provider-start-env'),
    HAPPIER_STACK_REPO_DIR: join(stackRootDir, '..', '..'),
    HAPPIER_STACK_SERVE_UI: '0',
    HAPPIER_STACK_DAEMON: '0',
    HAPPIER_STACK_RUNTIME_MODE: 'source',
    ...overrides,
  };
  delete env.HAPPIER_DB_PROVIDER;
  delete env.HAPPY_DB_PROVIDER;
  return Object.assign(env, overrides);
}

test('hstack start materializes the full server default and postgresql alias', async () => {
  for (const [env, expectedSource] of [
    [isolatedEnv(), 'postgres'],
    [isolatedEnv({ HAPPY_DB_PROVIDER: ' PostgreSQL ' }), 'postgres'],
  ]) {
    const result = await runNode([runScript, '--server=happier-server', '--no-ui', '--json'], {
      cwd: stackRootDir,
      env,
    });
    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).dbProvider, expectedSource);
  }
});

test('hstack start accepts local databases with the full preset and rejects corrupt metadata', async () => {
  for (const provider of ['sqlite', 'pglite']) {
    const result = await runNode([runScript, '--server=happier-server', '--no-ui', '--json'], {
      cwd: stackRootDir,
      env: isolatedEnv({ HAPPIER_DB_PROVIDER: provider }),
    });
    assert.equal(result.code, 0, `provider=${provider}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).dbProvider, provider);
  }
  for (const provider of ['', 'unsupported']) {
    const result = await runNode([runScript, '--server=happier-server', '--no-ui', '--json'], {
      cwd: stackRootDir,
      env: isolatedEnv({ HAPPIER_DB_PROVIDER: provider }),
    });
    assert.notEqual(result.code, 0, `provider=${JSON.stringify(provider)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /unsupported DB provider/i);
  }
});

test('hstack start requires explicit mysql database authority before startup', async () => {
  const missing = await runNode([runScript, '--server=happier-server', '--no-ui', '--json'], {
    cwd: stackRootDir,
    env: isolatedEnv({ HAPPIER_DB_PROVIDER: 'mysql' }),
  });
  assert.notEqual(missing.code, 0, `stdout:\n${missing.stdout}\nstderr:\n${missing.stderr}`);
  assert.match(`${missing.stdout}\n${missing.stderr}`, /mysql.*explicit DATABASE_URL/i);

  const explicit = await runNode([runScript, '--server=happier-server', '--no-ui', '--json'], {
    cwd: stackRootDir,
    env: isolatedEnv({
      HAPPIER_DB_PROVIDER: 'mysql',
      DATABASE_URL: 'mysql://operator/db',
    }),
  });
  assert.equal(explicit.code, 0, `stdout:\n${explicit.stdout}\nstderr:\n${explicit.stderr}`);
  assert.equal(JSON.parse(explicit.stdout).dbProvider, 'mysql');
});
