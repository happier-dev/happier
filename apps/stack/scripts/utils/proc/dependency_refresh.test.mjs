import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectDependencyRefresh, withDependencyRefresh } from './dependency_refresh.mjs';

async function touch(path, ms) {
  const date = new Date(ms);
  await utimes(path, date, date);
}

test('dependency readiness survives relocation of a byte-identical installed tree', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-dependency-relocation-'));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  const sourceRoot = join(fixtureRoot, 'source');
  const relocatedRoot = join(fixtureRoot, 'relocated');
  await mkdir(join(sourceRoot, 'node_modules'), { recursive: true });
  await writeFile(join(sourceRoot, 'install-input.txt'), 'fixture input\n', 'utf8');
  await symlink(join(sourceRoot, 'install-input.txt'), join(sourceRoot, 'install-input-link'));
  await Promise.all([
    writeFile(join(sourceRoot, 'package.json'), '{"name":"fixture","private":true,"packageManager":"yarn@1.22.22","happier":{"installFreshnessInputs":["install-input-link"]}}\n', 'utf8'),
    writeFile(join(sourceRoot, 'yarn.lock'), '# fixture\n', 'utf8'),
  ]);

  let refreshCount = 0;
  await withDependencyRefresh({ installDir: sourceRoot }, async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 1);
  const sourceInspection = await inspectDependencyRefresh({ installDir: sourceRoot });
  assert.equal(sourceInspection.required, false);
  const marker = JSON.parse(await readFile(sourceInspection.markerPath, 'utf8'));
  assert.equal(marker.version, 5);
  assert.equal(Object.hasOwn(marker, 'installDir'), false);
  assert.equal(marker.inputs.every((input) => !input.path.includes(sourceRoot)), true);
  assert.equal(JSON.stringify(marker).includes(sourceRoot), false, 'symlink targets must be hashed instead of storing absolute paths');

  await cp(sourceRoot, relocatedRoot, { recursive: true });
  assert.equal(
    (await inspectDependencyRefresh({ installDir: relocatedRoot })).required,
    false,
    'absolute installation paths must not participate in dependency freshness identity',
  );
  await withDependencyRefresh({ installDir: relocatedRoot }, async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 1, 'relocating a ready tree must not trigger another install');
});

test('dependency readiness ignores timestamp-only churn but detects same-size content changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-content-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const packagePath = join(root, 'package.json');
  await Promise.all([
    mkdir(join(root, 'node_modules'), { recursive: true }),
    writeFile(packagePath, '{"value":"one"}\n', 'utf8'),
    writeFile(join(root, 'yarn.lock'), '# fixture\n', 'utf8'),
  ]);

  await withDependencyRefresh({ installDir: root }, async () => {});
  const initial = await stat(packagePath);
  await touch(packagePath, initial.mtimeMs + 60_000);
  assert.equal(
    (await inspectDependencyRefresh({ installDir: root })).required,
    false,
    'metadata-only sync churn must not reinstall unchanged dependencies',
  );

  await writeFile(packagePath, '{"value":"two"}\n', 'utf8');
  await touch(packagePath, initial.mtimeMs + 60_000);
  assert.equal(
    (await inspectDependencyRefresh({ installDir: root })).required,
    true,
    'a same-size content rewrite must invalidate dependencies',
  );
});

test('dependency readiness rejects legacy markers and a different toolchain identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-identity-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([
    mkdir(join(root, 'node_modules'), { recursive: true }),
    writeFile(join(root, 'package.json'), '{"name":"fixture","private":true,"packageManager":"yarn@1.22.22"}\n', 'utf8'),
    writeFile(join(root, 'yarn.lock'), '# fixture\n', 'utf8'),
  ]);
  const armIdentity = {
    packageManager: 'yarn@1.22.22',
    nodeVersion: '24.0.0',
    nodeAbi: '137',
    platform: 'linux',
    architecture: 'arm64',
    installMode: 'development-full-v1',
  };
  const x64Identity = { ...armIdentity, architecture: 'x64' };

  await withDependencyRefresh({ installDir: root, runtimeIdentity: armIdentity }, async () => {});
  const admitted = await inspectDependencyRefresh({ installDir: root, runtimeIdentity: armIdentity });
  assert.equal(admitted.required, false);
  assert.equal(
    (await inspectDependencyRefresh({ installDir: root, runtimeIdentity: x64Identity })).required,
    true,
    'architecture-sensitive dependency state must not cross worker architectures',
  );

  const marker = JSON.parse(await readFile(admitted.markerPath, 'utf8'));
  await writeFile(admitted.markerPath, `${JSON.stringify({
    ...marker,
    version: 2,
    installDir: root,
  })}\n`, 'utf8');
  assert.equal(
    (await inspectDependencyRefresh({ installDir: root, runtimeIdentity: armIdentity })).required,
    true,
    'legacy absolute-path markers remain stale on read',
  );
});
