// @happier-test-preparation source
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSourceRuntimeDependencyIdentity } from '../../apps/stack/scripts/build/source_author_inputs.mjs';
import * as owner from './sourceRuntimeDependencies.mjs';

test('dependency refusal publishes its own typed status and successful admission clears it', async () => {
  const decisions = [];
  const stop = owner.observeSourceRuntimeDependencies('/retained/entry.mjs', status => decisions.push(status));
  try {
    await assert.rejects(owner.assertSourceRuntimeDependenciesCurrent({ entrypoint: '/retained/entry.mjs', record: {} }),
      { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', subtype: 'no_closure' });
    assert.deepEqual(decisions, [{ code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', subtype: 'no_closure' }]);
    await owner.assertSourceRuntimeDependenciesCurrent({ entrypoint: '/other/entry.mjs', record: {} }).catch(() => {});
    assert.equal(decisions.length, 1);
    await owner.assertSourceRuntimeDependenciesCurrent({ entrypoint: '/retained/entry.mjs', record: null });
    assert.equal(decisions.at(-1), null);
  } finally { stop(); }
});


test('Prisma-only publications preserve CLI, daemon and runner admission but invalidate a consuming server', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-prisma-invalidation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const markerPath = join(root, 'node_modules', '.happier-stack-dependencies-ready');
  const generationPath = join(root, 'dependency-install.lock.generation');
  await mkdir(join(root, 'node_modules', 'runtime-input'), { recursive: true });
  await mkdir(join(root, 'apps'));
  await symlink(fileURLToPath(new URL('../../apps/stack', import.meta.url)), join(root, 'apps', 'stack'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(root, 'package.json'), '{"private":true}');
  await writeFile(join(root, 'node_modules/runtime-input/package.json'), '{"name":"runtime-input","main":"index.cjs"}');
  await writeFile(join(root, 'node_modules/runtime-input/index.cjs'), 'exports.value = 1;');
  const imports = [{ path: 'runtime-input', resolveFrom: join(root, 'package.json') }];
  const closure = { identity: readSourceRuntimeDependencyIdentity({ imports }), imports };
  await writeFile(markerPath, JSON.stringify({ identity: 'installed-tree' }));
  const captured = { identity: 'installed-tree', writerActive: false, markerPath, generationPath,
    generation: 'installed', completedGeneration: 'installed', completedExpoGeneration: 'installed' };
  const publish = state => writeFile(generationPath, JSON.stringify(state));
  const admit = component => owner.assertSourceRuntimeDependenciesCurrent({
    entrypoint: join(root, component, 'entry.mjs'), component,
    record: { dependencyPublication: captured, ...(component === 'server' ? {} : { runtimeDependencyClosure: closure }) },
  });
  await publish({ generation: 'prisma', completedGeneration: 'prisma', completedExpoGeneration: 'installed',
    outputsChanged: ['server-generated-client:prisma'] });
  let traversals = 0;
  const readDirectory = fs.readdirSync;
  fs.readdirSync = (path, ...args) => {
    if (String(path) === join(root, 'node_modules/runtime-input')) traversals++;
    return readDirectory(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    for (const component of ['cli', 'daemon', 'runner']) await assert.doesNotReject(admit(component));
  } finally {
    fs.readdirSync = readDirectory;
    syncBuiltinESMExports();
  }
  assert.equal(traversals, 0, 'server-only publications must not revalidate unrelated installed runtime closures');
  await assert.rejects(admit('server'), { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED' });
  await writeFile(join(root, 'node_modules/runtime-input/index.cjs'), 'exports.value = 200;');
  // A later Prisma completion must not hide an intervening real installation,
  // even when the marker and manifest identity are unchanged.
  await publish({ generation: 'later-prisma', completedGeneration: 'later-prisma', completedExpoGeneration: 'reinstalled',
    outputsChanged: ['server-generated-client:prisma'] });
  for (const component of ['cli', 'daemon', 'runner', 'server']) {
    await assert.rejects(admit(component), { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED' });
  }
  await publish({ generation: 'unfinished', completedGeneration: 'prisma', completedExpoGeneration: 'installed',
    outputsChanged: ['server-generated-client:prisma'] });
  // An unfinished writer must never admit a retained runtime.
  await assert.rejects(admit('cli'), { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED' });
});
