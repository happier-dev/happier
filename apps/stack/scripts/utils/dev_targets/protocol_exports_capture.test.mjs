import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv } from '../../testkit/core/native_admission_fixture.mjs';

test('AUTO synchronization publishes Protocol exports on the controller before the worker verifies them', {
  skip: process.platform === 'win32',
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'protocol-exports-capture-' });
  const packageRoot = fixture.path('packages/protocol');
  await mkdir(join(packageRoot, 'src'), { recursive: true });
  await mkdir(join(packageRoot, 'scripts'));
  const manifestPath = join(packageRoot, 'package.json');
  const original = JSON.stringify({ name: '@happier-dev/protocol', exports: {} });
  await writeFile(manifestPath, original);
  await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
  await writeFile(join(packageRoot, 'export-aliases.json'), '{}');
  await writeFile(join(packageRoot, 'src/added.ts'), 'export const value = 1;');
  // Relocate only the fixture package root; the projection CLI, generator,
  // TypeScript inventory and publication lock remain the production owners.
  const generator = new URL('../../../../../packages/protocol/scripts/generate-exports.mjs', import.meta.url).href;
  await writeFile(join(packageRoot, 'scripts/generate-exports.mjs'), `export * from ${JSON.stringify(generator)};`);
  const launcher = await readFile(new URL('../../../bin/hstack-exec', import.meta.url), 'utf8');
  const start = launcher.indexOf('\nflush_selected_sync() {');
  const end = launcher.indexOf('\nremote_load_probe() {', start);
  assert.ok(start > 0 && end > start);
  // Synchronization is the system boundary. At that point the real verifier
  // must already accept the manifest; checking it cannot repair the input.
  const transport = fixture.path('transport');
  await mkdir(transport);
  await writeFile(join(transport, 'hstack-dev-target-control'), '#!/bin/sh\nexec node "$SYNC_VERIFIER"\n', { mode: 0o755 });
  const verifier = fixture.path('verify.mjs');
  await writeFile(verifier, `import { generateProtocolExports } from ${JSON.stringify(generator)};
await generateProtocolExports({ packageRoot: ${JSON.stringify(packageRoot)}, check: true });`);
  const script = fixture.path('flush.sh');
  await writeFile(script, `repo_root=$1
projection_generator=$2
script_dir=$3
command_repo_root=
requires_remote_dependencies=1
requires_remote_workspace_preparation=1
selected_name=worker
selected_number=1
sync_name_for_target() { printf '%s' fixture; }
configure_mutagen_environment() { :; }
run_dependency_free_node() { node "$@"; }
${launcher.slice(start, end)}
shift 3
flush_selected_sync "$@"
`);
  const env = { ...buildNativeAdmissionFixtureEnv(), CI: '', npm_lifecycle_event: '',
    HAPPIER_DEV_TARGET_EXECUTION: '', SYNC_VERIFIER: verifier };
  const flush = (...args) => spawnSync('/bin/sh', [script, fixture.root,
    fileURLToPath(new URL('./native_execution_projection.mjs', import.meta.url)), transport, ...args],
  { env, encoding: 'utf8' });
  let result = flush();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).exports['./added'].default, './dist/added.js');
  const marker = new Date('2020-01-01T00:00:00Z');
  await utimes(manifestPath, marker, marker);
  result = flush();
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await stat(manifestPath)).mtimeMs, marker.getTime(), 'unchanged AUTO preparation publishes no manifest');
  await writeFile(manifestPath, original);
  for (const context of [{ CI: 'true' }, { npm_lifecycle_event: 'prepack' }, {}]) {
    const args = Object.keys(context).length ? [] : ['--artifact'];
    const strict = spawnSync('/bin/sh', [script, fixture.root,
      fileURLToPath(new URL('./native_execution_projection.mjs', import.meta.url)), transport, ...args],
    { env: { ...env, ...context }, encoding: 'utf8' });
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /Protocol exports are stale/);
    assert.equal(await readFile(manifestPath, 'utf8'), original);
  }
});
