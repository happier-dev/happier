import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MUTAGEN_SYNC_LIST_JSON_TEMPLATE,
  parseMutagenSyncList,
} from './utils/dev_targets/mutagen_runtime.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const controlExecutable = resolve(testDir, '..', 'bin', 'hstack-dev-target-control');

function runMutagen(args, env) {
  const result = spawnSync('mutagen', args, { env, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `mutagen ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

test('native sync check accepts a healthy session from the real Mutagen public template model', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-target-control-real-mutagen-'));
  const alpha = join(root, 'alpha');
  const beta = join(root, 'beta');
  const dataDir = join(root, 'mutagen-data');
  const sessionName = `happier-template-${process.pid}`;
  await Promise.all([
    mkdir(alpha, { recursive: true }),
    mkdir(beta, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
  ]);
  await writeFile(join(alpha, 'healthy.txt'), 'healthy\n');
  const env = {
    ...process.env,
    DBUS_SESSION_BUS_ADDRESS: '',
    MUTAGEN_DATA_DIRECTORY: dataDir,
  };
  t.after(async () => {
    spawnSync('mutagen', ['sync', 'terminate', sessionName], { env, encoding: 'utf8' });
    spawnSync('mutagen', ['daemon', 'stop'], { env, encoding: 'utf8' });
    await rm(root, { recursive: true, force: true });
  });

  runMutagen([
    'sync', 'create',
    '--name', sessionName,
    '--no-global-configuration',
    '--watch-mode=no-watch',
    alpha,
    beta,
  ], env);
  runMutagen(['sync', 'flush', sessionName], env);

  const publicJsonStatus = runMutagen([
    'sync', 'list', sessionName,
    '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE,
  ], env);
  assert.equal(
    parseMutagenSyncList(publicJsonStatus.stdout, sessionName).state,
    'ready',
    'the JavaScript Windows adapter must consume the real Mutagen JSON model',
  );

  const result = spawnSync(controlExecutable, ['--sync-check', sessionName], {
    env,
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `healthy Mutagen session was rejected\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const verboseResult = spawnSync(controlExecutable, ['--sync-check', sessionName], {
    env: { ...env, HSTACK_SYNC_CHECK_VERBOSE: '1' },
    encoding: 'utf8',
  });
  assert.ifError(verboseResult.error);
  assert.equal(
    verboseResult.status,
    0,
    `healthy Mutagen session did not render the native public-model evidence\nstdout:\n${verboseResult.stdout}\nstderr:\n${verboseResult.stderr}`,
  );
  const nativeFields = verboseResult.stdout.trim().split('|');
  assert.deepEqual(nativeFields.slice(0, 12), [
    sessionName,
    'Watching',
    'false',
    'true',
    '1',
    '0/0',
    '0/0',
    'true',
    '1',
    '0/0',
    '0/0',
    'active',
  ]);
  assert.match(nativeFields[12], /^[1-9][0-9]*$/u);
  assert.deepEqual(nativeFields.slice(13), ['ok', '0', '0']);

  for (const content of ['written immediately before the native barrier\n', 'newer demand after the previous success\n']) {
    await writeFile(join(alpha, 'healthy.txt'), content);
    const flushed = spawnSync(controlExecutable, [
      '--sync-flush', sessionName, '--', 'mutagen', 'sync', 'flush', sessionName,
    ], { env, encoding: 'utf8' });
    assert.ifError(flushed.error);
    assert.equal(flushed.status, 0, flushed.stderr);
    assert.equal(await readFile(join(beta, 'healthy.txt'), 'utf8'), content);
  }

  runMutagen(['sync', 'pause', sessionName], env);
  const pausedPublicJsonStatus = runMutagen([
    'sync', 'list', sessionName,
    '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE,
  ], env);
  assert.equal(
    parseMutagenSyncList(pausedPublicJsonStatus.stdout, sessionName).state,
    'paused',
    'the JavaScript Windows adapter must consume a paused real public model with absent endpoint state',
  );

  const pausedResult = spawnSync(controlExecutable, ['--sync-check', sessionName], {
    env,
    encoding: 'utf8',
  });
  assert.ifError(pausedResult.error);
  assert.equal(pausedResult.status, 1);
  assert.match(pausedResult.stderr, /synchronization is paused/u);
});
