import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeArtifactManifest } from './runtime/shared/artifact_manifest.mjs';
import { createRuntimeSnapshotFixture, runNode } from './testkit/runtime_snapshot_testkit.mjs';
import { parseEnvToObject } from './utils/env/dotenv.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

async function createWebArtifact(stackDir, {
  fingerprint,
  createdAt,
  html,
}) {
  const artifactDir = join(stackDir, 'artifacts', 'web', fingerprint);
  const payloadDir = join(artifactDir, 'payload');
  await mkdir(payloadDir, { recursive: true });
  await writeFile(join(payloadDir, 'index.html'), html, 'utf8');
  await writeArtifactManifest({
    artifactDir,
    manifest: {
      version: 1,
      component: 'web',
      artifactFingerprint: fingerprint,
      sourceFingerprint: 'src-1',
      createdAt,
      source: {
        repoDir: '/tmp/repo',
        serverComponent: 'happier-server-light',
        dbProvider: 'sqlite',
        commitSha: 'fixture',
        dirtyHash: 'dirty',
        sourceFingerprint: 'src-1',
        builtAt: createdAt,
      },
      payloadDir: 'payload',
      entrypoint: 'index.html',
    },
  });
}

test('hstack stack runtime activate --web updates only the current runtime web payload', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'prod-dev' });

  await createWebArtifact(fixture.stackDir, {
    fingerprint: 'web-new',
    createdAt: '2026-03-08T12:00:00.000Z',
    html: '<html>new runtime web</html>\n',
  });

  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    // Keep the command's source identity stable even while other agents edit the
    // shared checkout during this two-invocation reuse assertion.
    HAPPIER_STACK_REPO_DIR: fixture.root,
  };

  const res = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', fixture.stackName, 'activate', '--web', '--json'],
    { cwd: rootDir, env },
  );

  assert.equal(res.code, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.activatedComponents, ['web']);
  assert.equal(parsed.consumerStackName, fixture.stackName);
  assert.equal(parsed.producerStackName, fixture.stackName);
  assert.equal(typeof parsed.snapshotId, 'string');
  assert.equal(typeof parsed.snapshotPath, 'string');
  assert.equal(parsed.reused, false);
  assert.equal(parsed.selected, true);
  assert.equal(
    await readFile(join(fixture.stackDir, 'runtime', 'current', 'ui', 'index.html'), 'utf8'),
    '<html>new runtime web</html>\n',
  );
  assert.equal(
    await readFile(join(fixture.stackDir, 'runtime', 'current', 'server', 'happier-server'), 'utf8'),
    '#!/bin/sh\nexit 0\n',
  );
  assert.equal(
    await readFile(join(fixture.stackDir, 'runtime', 'current', 'cli', 'happier'), 'utf8'),
    '#!/bin/sh\necho SNAPSHOT CLI HELP\n',
  );

  const stackEnvAfter = parseEnvToObject(await readFile(join(fixture.stackDir, 'env'), 'utf8'));
  assert.equal(stackEnvAfter.HAPPIER_STACK_RUNTIME_MODE, 'prefer');

  const reusedRes = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', fixture.stackName, 'activate', '--web', '--json'],
    { cwd: rootDir, env },
  );
  assert.equal(reusedRes.code, 0, `stdout:\n${reusedRes.stdout}\nstderr:\n${reusedRes.stderr}`);
  const reused = JSON.parse(reusedRes.stdout.trim());
  assert.equal(reused.snapshotId, parsed.snapshotId);
  assert.equal(reused.snapshotPath, parsed.snapshotPath);
  assert.equal(reused.reused, true);
  assert.equal(reused.selected, true);
});

test('hstack stack runtime activate --web fails closed when the active runtime server flavor mismatches the stack', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'prod-dev' });

  await createWebArtifact(fixture.stackDir, {
    fingerprint: 'web-new',
    createdAt: '2026-03-08T12:00:00.000Z',
    html: '<html>new runtime web</html>\n',
  });

  const manifestPath = join(fixture.snapshotDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.source = {
    repoDir: '/tmp/repo',
    serverComponent: 'happier-server',
    dbProvider: 'postgres',
    commitSha: 'fixture',
    dirtyHash: 'dirty',
    sourceFingerprint: 'src-1',
    builtAt: '2026-03-08T11:00:00.000Z',
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
  };

  const res = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', fixture.stackName, 'activate', '--web', '--json'],
    { cwd: rootDir, env },
  );

  assert.equal(res.code, 1, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /cannot reuse the active runtime server artifact across server flavors/i);
});

test('hstack stack runtime select adopts the producer snapshot without publishing or changing the producer pointer', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const producer = await createRuntimeSnapshotFixture(t, { stackName: 'repo-producer' });
  const consumerStackName = 'qa-consumer';
  const consumerStackDir = join(producer.storageDir, consumerStackName);
  const consumerEnvPath = join(consumerStackDir, 'env');
  await mkdir(consumerStackDir, { recursive: true });
  await writeFile(
    consumerEnvPath,
    [
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      'HAPPIER_STACK_RUNTIME_MODE=require',
      `HAPPIER_STACK_REPO_DIR=${producer.root}`,
      `HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=${producer.stackName}`,
      '',
    ].join('\n'),
    'utf8',
  );
  const producerPointerPath = join(producer.stackDir, 'runtime', 'current.json');
  const producerEnvPath = join(producer.stackDir, 'env');
  const consumerRuntimeStatePath = join(consumerStackDir, 'stack.runtime.json');
  const producerPointerBefore = await readFile(producerPointerPath, 'utf8');
  const producerEnvBefore = await readFile(producerEnvPath, 'utf8');
  await writeFile(
    consumerRuntimeStatePath,
    JSON.stringify({
      version: 1,
      stackName: consumerStackName,
      processes: { daemonPid: 999_999, daemonPids: [999_999] },
    }) + '\n',
    'utf8',
  );
  const consumerRuntimeStateBefore = await readFile(consumerRuntimeStatePath, 'utf8');

  const res = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', consumerStackName, 'select', '--json'],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: producer.storageDir,
        HAPPIER_STACK_STACK: consumerStackName,
        HAPPIER_STACK_ENV_FILE: consumerEnvPath,
        HAPPIER_STACK_REPO_DIR: producer.root,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      },
    },
  );

  assert.equal(res.code, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.consumerStackName, consumerStackName);
  assert.equal(parsed.producerStackName, producer.stackName);
  assert.equal(parsed.snapshotId, 'snap-1');
  assert.equal(parsed.snapshotPath, producer.snapshotDir);
  assert.equal(parsed.selected, true);
  assert.equal(parsed.reused, true);
  assert.equal(await readFile(producerPointerPath, 'utf8'), producerPointerBefore);
  assert.equal(await readFile(producerEnvPath, 'utf8'), producerEnvBefore);
  assert.equal(await readFile(consumerRuntimeStatePath, 'utf8'), consumerRuntimeStateBefore);

  const consumerPointer = JSON.parse(await readFile(join(consumerStackDir, 'runtime', 'current.json'), 'utf8'));
  assert.equal(consumerPointer.snapshotId, 'snap-1');
  assert.equal(consumerPointer.snapshotPath, producer.snapshotDir);
  assert.equal(consumerPointer.producerStackName, producer.stackName);
  assert.equal(
    await readFile(join(consumerStackDir, 'runtime', 'current', 'ui', 'index.html'), 'utf8'),
    '<html></html>\n',
  );
  const consumerEnvAfter = parseEnvToObject(await readFile(consumerEnvPath, 'utf8'));
  assert.equal(consumerEnvAfter.HAPPIER_STACK_RUNTIME_MODE, 'require');
});

test('hstack stack runtime select does not change an unset consumer runtime mode', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const producer = await createRuntimeSnapshotFixture(t, { stackName: 'repo-producer' });
  const consumerStackName = 'qa-consumer';
  const consumerStackDir = join(producer.storageDir, consumerStackName);
  const consumerEnvPath = join(consumerStackDir, 'env');
  await mkdir(consumerStackDir, { recursive: true });
  await writeFile(
    consumerEnvPath,
    [
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_REPO_DIR=${producer.root}`,
      `HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=${producer.stackName}`,
      '',
    ].join('\n'),
    'utf8',
  );

  const res = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', consumerStackName, 'select', '--json'],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: producer.storageDir,
        HAPPIER_STACK_STACK: consumerStackName,
        HAPPIER_STACK_ENV_FILE: consumerEnvPath,
        HAPPIER_STACK_REPO_DIR: producer.root,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      },
    },
  );

  assert.equal(res.code, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const consumerEnvAfter = parseEnvToObject(await readFile(consumerEnvPath, 'utf8'));
  assert.equal(consumerEnvAfter.HAPPIER_STACK_RUNTIME_MODE, undefined);
});

test('hstack stack runtime select does not create a repository producer identity', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'repo-producer' });
  const consumerStackName = 'qa-consumer';
  const consumerStackDir = join(fixture.storageDir, consumerStackName);
  const consumerEnvPath = join(consumerStackDir, 'env');
  const gitIdentityPath = join(fixture.root, '.git', 'happier-stack-stackless-id');
  await mkdir(join(fixture.root, '.git'), { recursive: true });
  await mkdir(consumerStackDir, { recursive: true });
  await writeFile(
    consumerEnvPath,
    [
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_REPO_DIR=${fixture.root}`,
      '',
    ].join('\n'),
    'utf8',
  );

  const res = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', consumerStackName, 'select', '--json'],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
        HAPPIER_STACK_STACK: consumerStackName,
        HAPPIER_STACK_ENV_FILE: consumerEnvPath,
        HAPPIER_STACK_REPO_DIR: fixture.root,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      },
    },
  );

  assert.equal(res.code, 1, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  await assert.rejects(readFile(gitIdentityPath, 'utf8'), { code: 'ENOENT' });
});

test('hstack stack runtime select fails closed when the producer has no active snapshot', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const producer = await createRuntimeSnapshotFixture(t, { stackName: 'repo-producer' });
  const consumerStackName = 'qa-consumer';
  const consumerStackDir = join(producer.storageDir, consumerStackName);
  const consumerEnvPath = join(consumerStackDir, 'env');
  await rm(join(producer.stackDir, 'runtime', 'current.json'), { force: true });
  await mkdir(consumerStackDir, { recursive: true });
  await writeFile(
    consumerEnvPath,
    [
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      'HAPPIER_STACK_RUNTIME_MODE=require',
      `HAPPIER_STACK_REPO_DIR=${producer.root}`,
      `HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=${producer.stackName}`,
      '',
    ].join('\n'),
    'utf8',
  );

  const res = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', consumerStackName, 'select', '--json'],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: producer.storageDir,
        HAPPIER_STACK_STACK: consumerStackName,
        HAPPIER_STACK_ENV_FILE: consumerEnvPath,
        HAPPIER_STACK_REPO_DIR: producer.root,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      },
    },
  );

  assert.equal(res.code, 1, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /producer.*active runtime snapshot/i);
  assert.match(res.stderr, /stack build qa-consumer --server --daemon/i);
  assert.match(res.stderr, /stack runtime qa-consumer activate --all/i);
  await assert.rejects(readFile(join(consumerStackDir, 'runtime', 'current.json'), 'utf8'), { code: 'ENOENT' });
});

test('hstack stack runtime select refuses to mutate the runtime producer itself', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'repo-producer' });
  const producerPointerPath = join(fixture.stackDir, 'runtime', 'current.json');
  const producerPointerBefore = await readFile(producerPointerPath, 'utf8');
  await writeFile(
    join(fixture.stackDir, 'env'),
    [
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=${fixture.stackName}`,
      '',
    ].join('\n'),
    'utf8',
  );

  const res = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', fixture.stackName, 'select', '--json'],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
        HAPPIER_STACK_STACK: fixture.stackName,
        HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
        HAPPIER_STACK_REPO_DIR: fixture.root,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      },
    },
  );

  assert.equal(res.code, 1, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /is the runtime producer/i);
  assert.equal(await readFile(producerPointerPath, 'utf8'), producerPointerBefore);
});

test('hstack stack runtime select rejects a symlink alias of its producer before writing', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const producer = await createRuntimeSnapshotFixture(t, { stackName: 'repo-producer' });
  const consumerStackName = 'producer-alias';
  const consumerStackDir = join(producer.storageDir, consumerStackName);
  const producerPointerPath = join(producer.stackDir, 'runtime', 'current.json');
  const producerPointerBefore = await readFile(producerPointerPath, 'utf8');
  await writeFile(
    join(producer.stackDir, 'env'),
    [
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=${producer.stackName}`,
      '',
    ].join('\n'),
    'utf8',
  );
  await symlink(producer.stackDir, consumerStackDir, process.platform === 'win32' ? 'junction' : 'dir');

  const res = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', consumerStackName, 'select', '--json'],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: producer.storageDir,
        HAPPIER_STACK_STACK: consumerStackName,
        HAPPIER_STACK_ENV_FILE: join(consumerStackDir, 'env'),
        HAPPIER_STACK_REPO_DIR: producer.root,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      },
    },
  );

  assert.equal(res.code, 1, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /is the runtime producer/i);
  assert.equal(await readFile(producerPointerPath, 'utf8'), producerPointerBefore);
});

test('hstack stack runtime select rejects a producer pointer chain that resolves back to its consumer', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const consumer = await createRuntimeSnapshotFixture(t, { stackName: 'qa-consumer' });
  const producerStackName = 'producer-hop';
  const producerStackDir = join(consumer.storageDir, producerStackName);
  const consumerPointerPath = join(consumer.stackDir, 'runtime', 'current.json');
  const consumerPointerBefore = await readFile(consumerPointerPath, 'utf8');
  const consumerEnvPath = join(consumer.stackDir, 'env');

  await mkdir(join(producerStackDir, 'runtime'), { recursive: true });
  await writeFile(
    consumerEnvPath,
    [
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_REPO_DIR=${consumer.root}`,
      `HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=${producerStackName}`,
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(producerStackDir, 'runtime', 'current.json'),
    JSON.stringify({
      version: 1,
      snapshotId: 'snap-1',
      snapshotPath: consumer.snapshotDir,
      producerStackName: consumer.stackName,
      sourceFingerprint: 'src-1',
    }) + '\n',
    'utf8',
  );

  const res = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', consumer.stackName, 'select', '--json'],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: consumer.storageDir,
        HAPPIER_STACK_STACK: consumer.stackName,
        HAPPIER_STACK_ENV_FILE: consumerEnvPath,
        HAPPIER_STACK_REPO_DIR: consumer.root,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      },
    },
  );

  assert.equal(res.code, 1, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /is the runtime producer/i);
  assert.equal(await readFile(consumerPointerPath, 'utf8'), consumerPointerBefore);
});

test('hstack stack runtime select rejects a producer snapshot root symlink outside its builds directory', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const producer = await createRuntimeSnapshotFixture(t, { stackName: 'repo-producer' });
  const consumerStackName = 'qa-consumer';
  const consumerStackDir = join(producer.storageDir, consumerStackName);
  const consumerEnvPath = join(consumerStackDir, 'env');
  const externalSnapshotDir = join(producer.root, 'external-snapshot');

  await mkdir(consumerStackDir, { recursive: true });
  await writeFile(
    consumerEnvPath,
    [
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_REPO_DIR=${producer.root}`,
      `HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=${producer.stackName}`,
      '',
    ].join('\n'),
    'utf8',
  );
  await rename(producer.snapshotDir, externalSnapshotDir);
  await symlink(externalSnapshotDir, producer.snapshotDir, process.platform === 'win32' ? 'junction' : 'dir');

  const res = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', consumerStackName, 'select', '--json'],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: producer.storageDir,
        HAPPIER_STACK_STACK: consumerStackName,
        HAPPIER_STACK_ENV_FILE: consumerEnvPath,
        HAPPIER_STACK_REPO_DIR: producer.root,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      },
    },
  );

  assert.equal(res.code, 1, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /snapshot.*outside.*runtime builds/i);
  await assert.rejects(readFile(join(consumerStackDir, 'runtime', 'current.json'), 'utf8'), { code: 'ENOENT' });
});

test('hstack stack runtime select permits producer snapshots with reused component links inside its builds directory', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const producer = await createRuntimeSnapshotFixture(t, { stackName: 'repo-producer' });
  const consumerStackName = 'qa-consumer';
  const consumerStackDir = join(producer.storageDir, consumerStackName);
  const consumerEnvPath = join(consumerStackDir, 'env');
  const reusedSnapshotId = 'snap-reused';
  const reusedSnapshotDir = join(producer.stackDir, 'runtime', 'builds', reusedSnapshotId);
  const manifest = JSON.parse(await readFile(join(producer.snapshotDir, 'manifest.json'), 'utf8'));

  await mkdir(consumerStackDir, { recursive: true });
  await writeFile(
    consumerEnvPath,
    [
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_REPO_DIR=${producer.root}`,
      `HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=${producer.stackName}`,
      '',
    ].join('\n'),
    'utf8',
  );
  await mkdir(reusedSnapshotDir, { recursive: true });
  for (const component of ['ui', 'server', 'cli']) {
    await symlink(
      join(producer.snapshotDir, component),
      join(reusedSnapshotDir, component),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  manifest.snapshotId = reusedSnapshotId;
  await writeFile(join(reusedSnapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await writeFile(
    join(producer.stackDir, 'runtime', 'current.json'),
    JSON.stringify({
      version: 1,
      snapshotId: reusedSnapshotId,
      snapshotPath: reusedSnapshotDir,
      sourceFingerprint: 'src-1',
    }) + '\n',
    'utf8',
  );

  const res = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', consumerStackName, 'select', '--json'],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: producer.storageDir,
        HAPPIER_STACK_STACK: consumerStackName,
        HAPPIER_STACK_ENV_FILE: consumerEnvPath,
        HAPPIER_STACK_REPO_DIR: producer.root,
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      },
    },
  );

  assert.equal(res.code, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.equal(JSON.parse(res.stdout).snapshotId, reusedSnapshotId);
  assert.equal(
    await readFile(join(consumerStackDir, 'runtime', 'current', 'server', 'happier-server'), 'utf8'),
    '#!/bin/sh\nexit 0\n',
  );
});

test('hstack stack runtime select rejects unsafe producer snapshot ids without writing the consumer', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const producer = await createRuntimeSnapshotFixture(t, { stackName: 'repo-producer' });
  const consumerStackName = 'qa-consumer';
  const consumerStackDir = join(producer.storageDir, consumerStackName);
  const consumerEnvPath = join(consumerStackDir, 'env');
  await mkdir(consumerStackDir, { recursive: true });
  await writeFile(
    consumerEnvPath,
    [
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_REPO_DIR=${producer.root}`,
      `HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=${producer.stackName}`,
      '',
    ].join('\n'),
    'utf8',
  );

  for (const snapshotId of ['../escaped', '/absolute-snapshot', 'nested/snapshot', 'nested\\snapshot']) {
    await writeFile(
      join(producer.stackDir, 'runtime', 'current.json'),
      JSON.stringify({
        version: 1,
        snapshotId,
        snapshotPath: join(producer.stackDir, 'runtime', 'builds', 'snap-1'),
        sourceFingerprint: 'src-1',
      }) + '\n',
      'utf8',
    );

    const res = await runNode(
      [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', consumerStackName, 'select', '--json'],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          HAPPIER_STACK_STORAGE_DIR: producer.storageDir,
          HAPPIER_STACK_STACK: consumerStackName,
          HAPPIER_STACK_ENV_FILE: consumerEnvPath,
          HAPPIER_STACK_REPO_DIR: producer.root,
          HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        },
      },
    );

    assert.equal(res.code, 1, `snapshot id ${snapshotId}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /snapshot id.*path segment/i);
    await assert.rejects(readFile(join(consumerStackDir, 'runtime', 'current.json'), 'utf8'), { code: 'ENOENT' });
  }
});
