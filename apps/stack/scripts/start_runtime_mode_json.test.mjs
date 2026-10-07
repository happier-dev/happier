import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeSnapshotFixture, runNode } from './testkit/runtime_snapshot_testkit.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeManagedRuntimeSnapshotLayout } from './testkit/core/runtime_snapshot_layout.mjs';
import { selectActiveProducerRuntimeSnapshot } from './build/activate_runtime_snapshot.mjs';

test('shared QA start composes a local daemon snapshot independently of its Darwin server and command pool', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const { root } = await createTempFixture(t, { prefix: 'hstack-mixed-qa-start-' });
  const storageDir = join(root, 'storage');
  const producer = join(storageDir, 'producer');
  const consumer = join(storageDir, 'qa');
  const source = join(root, 'source');
  const launcher = join(source, 'apps/stack/bin/hstack-exec');
  await mkdir(dirname(launcher), { recursive: true });
  // The process/SSH boundary reports observed hosts; placement and snapshot
  // admission remain real beneath the public start command.
  await writeFile(launcher, '#!/bin/sh\ncase "$*" in *--target=mac-host*) printf \'HSTACK_QA_HOST={"platform":"darwin","arch":"arm64","remote":true}\\n\' ;; *) printf \'HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true}\\n\'; printf \'[preferred-execution] selected worker (load=0.1)\\n\' >&2 ;; esac\n');
  await chmod(launcher, 0o755);
  const server = await writeManagedRuntimeSnapshotLayout({ stackDir: producer, snapshotId: 'darwin-server', target: { platform: 'darwin', arch: 'arm64' } });
  await writeManagedRuntimeSnapshotLayout({ stackDir: producer, snapshotId: 'linux-daemon', target: { platform: process.platform, arch: process.arch } });
  await mkdir(consumer, { recursive: true });
  await writeFile(join(consumer, 'env'), 'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\nHAPPIER_STACK_SHARED_DB_SOURCE_STACK=producer\nHAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=producer\n');
  const targets = ['mac-host', 'worker'].map(name => ({ name, platform: 'posix', ssh: name, repoDir: '/mirror', cliHomeDir: `/state/${name}/cli` }));
  await writeFile(join(producer, 'dev-targets.json'), JSON.stringify({ version: 3, targets, runtimePlacement: { qa: { mode: 'local' } }, commandExecution: { mode: 'auto', targets: ['worker'] } }));
  await writeFile(join(consumer, 'dev-targets.json'), JSON.stringify({ version: 3, targets, runtimePlacement: { server: { mode: 'prefer-target', target: 'mac-host' } } }));
  await selectActiveProducerRuntimeSnapshot({ consumerStackBaseDir: consumer, producerStackBaseDir: producer,
    producerStackName: 'producer', consumerStackName: 'qa', snapshotId: server.snapshotId,
    target: server.manifest.target, requiredComponents: ['server'] });
  const res = await runNode([join(rootDir, 'scripts/run.mjs'), '--json', '--runtime'], { cwd: rootDir, env: {
    ...process.env, HAPPIER_STACK_STACK: 'qa', HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer', HAPPIER_STACK_ENV_FILE: join(consumer, 'env'),
    HAPPIER_STACK_REPO_DIR: source, HAPPIER_STACK_DAEMON_AUTOSTART: '1',
  } });
  assert.equal(res.code, 0, res.stderr);
  const result = JSON.parse(res.stdout);
  assert.equal(result.target, 'mac-host');
  assert.equal(result.runtimeSnapshotId, 'darwin-server');
  assert.equal(result.daemonPlacement, 'local');
  assert.equal(result.daemonSnapshotId, 'linux-daemon');
});

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

test('hstack start --json --runtime reports runtime-backed launch paths', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t);

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'run.mjs'), '--json', '--runtime'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.mode, 'start');
  assert.equal(parsed.launchMode, 'runtime');
  assert.equal(parsed.runtimeSnapshotId, 'snap-1');
  assert.equal(parsed.cliDir, join(fixture.snapshotDir, 'cli'));
  assert.equal(parsed.serverDir, join(fixture.snapshotDir, 'server'));
  assert.equal(parsed.uiBuildDir, join(fixture.snapshotDir, 'ui'));
  assert.notEqual(parsed.cliDir, join(fixture.stackDir, 'runtime', 'current', 'cli'));
  assert.notEqual(parsed.serverDir, join(fixture.stackDir, 'runtime', 'current', 'server'));
  assert.notEqual(parsed.uiBuildDir, join(fixture.stackDir, 'runtime', 'current', 'ui'));
});

test('hstack start --mobile does not request an owned Expo process when the stack borrows Expo', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'runtime-borrowed-start' });
  await appendFile(
    join(fixture.stackDir, 'env'),
    'HAPPIER_STACK_EXPO_SOURCE_STACK=repo-producer\n',
    'utf8',
  );
  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
  };

  const res = await runNode(
    [join(rootDir, 'scripts', 'run.mjs'), '--json', '--runtime', '--mobile'],
    { cwd: rootDir, env },
  );
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.startMobile, true);
  assert.equal(parsed.startOwnedExpo, false);
  assert.equal(parsed.expoOwnership, 'borrowed');
});
