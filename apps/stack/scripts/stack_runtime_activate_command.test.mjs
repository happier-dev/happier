import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeArtifactManifest } from './runtime/shared/artifact_manifest.mjs';
import { createRuntimeSnapshotFixture, runNode } from './testkit/runtime_snapshot_testkit.mjs';

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
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
  };

  const res = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'runtime', fixture.stackName, 'activate', '--web', '--json'],
    { cwd: rootDir, env },
  );

  assert.equal(res.code, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.activatedComponents, ['web']);
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
