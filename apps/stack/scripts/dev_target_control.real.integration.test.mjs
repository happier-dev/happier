// @happier-test-preparation source
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MUTAGEN_SYNC_LIST_JSON_TEMPLATE,
  parseMutagenSyncList,
} from './utils/dev_targets/mutagen_runtime.mjs';
import { renderMutagenProject } from './utils/dev_targets/mutagen_project.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const controlExecutable = resolve(testDir, '..', 'bin', 'hstack-dev-target-control');
// Mutagen places its Unix daemon socket beneath the fixture. Routed TMPDIRs
// can exceed the platform socket-path limit before a session can be created.
const mutagenFixtureParent = process.platform === 'win32' ? tmpdir() : '/var/tmp';

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

test('fail-open no-watch replicas admit new root and package inputs while preserving artifact exclusions', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-mutagen-scan-scope-', parentDir: mutagenFixtureParent });
  const alpha = fixture.path('alpha');
  const beta = fixture.path('beta');
  const sessionName = `happier-scope-${process.pid}`;
  const files = {
    'package.json': '{}',
    'apps/stack/package.json': '{}',
    'apps/stack/scripts/known.mjs': 'known',
    'packages/lib/package.json': '{}',
    'packages/lib/src/index.ts': 'initial',
    'packages/lib/generated/input.json': 'generated',
    'brat/foreign.txt': 'foreign',
    'brat[copy]/foreign.txt': 'foreign with glob characters',
    '.cache/foreign.txt': 'cache',
    'apps/stack/mutagen/foreign.txt': 'foreign',
    'packages/lib/foreign/foreign.txt': 'foreign',
    'packages/lib/dist/built.js': 'local build',
    'packages/iroh-native/release-evidence/THIRD-PARTY-NOTICES.txt': 'local stale notices',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(alpha, dirname(path)), { recursive: true });
    await writeFile(join(alpha, path), content);
  }
  await mkdir(join(beta, 'node_modules'), { recursive: true });
  await writeFile(join(beta, 'node_modules/local.txt'), 'target-local');
  const rendered = renderMutagenProject({ sourceDir: alpha, targets: [] });
  const ignores = rendered.split('\n').filter(line => line.startsWith('        - ')).map(line => JSON.parse(line.slice(10)));
  const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: '', MUTAGEN_DATA_DIRECTORY: fixture.path('mutagen-data') };
  t.after(() => {
    spawnSync('mutagen', ['sync', 'terminate', sessionName], { env });
    spawnSync('mutagen', ['daemon', 'stop'], { env });
  });
  runMutagen(['sync', 'create', '--name', sessionName, '--no-global-configuration', '--sync-mode=one-way-replica',
    '--watch-mode=no-watch', ...ignores.flatMap(path => ['--ignore', path]), alpha, beta], env);
  runMutagen(['sync', 'flush', sessionName], env);
  for (const path of Object.keys(files).filter(path => path.includes('/dist/'))) {
    await assert.rejects(readFile(join(beta, path)), { code: 'ENOENT' });
  }
  assert.equal(await readFile(join(beta, 'packages/lib/generated/input.json'), 'utf8'), 'generated');
  const newInputs = ['packages/lib/src/new/fresh.ts', 'packages/new-package/package.json', 'packages/lib/new.config.mjs', 'new-root.config.mjs', 'new-root-tree/input.json', 'bratc/kept.txt'];
  for (const path of newInputs) {
    await mkdir(join(alpha, dirname(path)), { recursive: true });
    await writeFile(join(alpha, path), `fresh source: ${path}`);
  }
  const flushed = spawnSync(controlExecutable, ['--sync-flush', sessionName, '--', 'mutagen', 'sync', 'flush', sessionName], { env, encoding: 'utf8' });
  assert.ifError(flushed.error);
  assert.equal(flushed.status, 0, flushed.stderr);
  for (const path of newInputs) assert.equal(await readFile(join(beta, path), 'utf8'), `fresh source: ${path}`);
  for (const path of Object.keys(files).filter(path => path.includes('foreign'))) {
    assert.equal(await readFile(join(beta, path), 'utf8'), files[path]);
  }
  assert.equal(await readFile(join(beta, 'node_modules/local.txt'), 'utf8'), 'target-local');
  const nativeEvidence = 'packages/iroh-native/release-evidence';
  await mkdir(join(beta, nativeEvidence), { recursive: true });
  await writeFile(join(beta, nativeEvidence, 'THIRD-PARTY-NOTICES.txt'), 'target notices');
  await writeFile(join(beta, nativeEvidence, 'sbom.cdx.json'), 'target SBOM');
  runMutagen(['sync', 'flush', sessionName], env);
  assert.equal(await readFile(join(beta, nativeEvidence, 'THIRD-PARTY-NOTICES.txt'), 'utf8'), 'target notices');
  assert.equal(await readFile(join(beta, nativeEvidence, 'sbom.cdx.json'), 'utf8'), 'target SBOM');
});

test('real Mutagen preserves worker-created plugin output roots absent from the controller without conflicts', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-plugin-outputs-', parentDir: mutagenFixtureParent, registerCleanup: false });
  const alpha = fixture.path('alpha');
  const beta = fixture.path('beta');
  const source = 'packages/plugins/new-plugin/src/manifest.ts';
  const outputs = 'packages/plugins/new-plugin/.happier-plugin';
  await mkdir(join(alpha, dirname(source)), { recursive: true });
  await mkdir(beta, { recursive: true });
  await writeFile(join(alpha, source), 'controller declaration');
  const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: '', MUTAGEN_DATA_DIRECTORY: fixture.path('mutagen-data') };
  const sessionName = `happier-plugin-outputs-${process.pid}`;
  t.after(async () => {
    spawnSync('mutagen', ['sync', 'terminate', sessionName], { env });
    spawnSync('mutagen', ['daemon', 'stop'], { env });
    await fixture.cleanup();
  });
  const ignores = renderMutagenProject({ sourceDir: alpha, targets: [] }).split('\n')
    .filter(line => line.startsWith('        - ')).map(line => JSON.parse(line.slice(10)));
  runMutagen(['sync', 'create', '--name', sessionName, '--no-global-configuration', '--sync-mode=one-way-replica',
    '--watch-mode=no-watch', ...ignores.flatMap(path => ['--ignore', path]), alpha, beta], env);
  runMutagen(['sync', 'flush', sessionName], env);
  // A cold worker builds after source admission, before the next dispatch.
  await mkdir(join(beta, outputs), { recursive: true });
  const generated = { 'daemon.js': 'worker runtime', '.happier-daemon-outputs.json': '{}', 'plugin.json': '{}' };
  for (const [name, bytes] of Object.entries(generated)) await writeFile(join(beta, outputs, name), bytes);
  await writeFile(join(alpha, source), 'updated controller declaration');
  for (let cycle = 0; cycle < 2; cycle++) {
    runMutagen(['sync', 'flush', sessionName], env);
    const listed = runMutagen(['sync', 'list', sessionName, '--template', MUTAGEN_SYNC_LIST_JSON_TEMPLATE], env);
    const status = parseMutagenSyncList(listed.stdout, sessionName);
    assert.equal(status.state, 'ready', 'worker-only generated output roots must not block dispatch');
    assert.equal(await readFile(join(beta, source), 'utf8'), 'updated controller declaration');
    for (const [name, bytes] of Object.entries(generated)) assert.equal(await readFile(join(beta, outputs, name), 'utf8'), bytes);
  }
  await assert.rejects(readFile(join(alpha, outputs, 'plugin.json')), { code: 'ENOENT' });
});

test('real Mutagen flush excludes a live-appended project timeline and retains worker inputs', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-mutagen-live-timeline-', parentDir: mutagenFixtureParent, registerCleanup: false });
  const alpha = fixture.path('alpha');
  const beta = fixture.path('beta');
  const timeline = '.project/plans/2026-10-02-changes-walkthrough/lanes/wt-verify/logs/N5-timeline.txt';
  const inputs = ['apps/stack/source.mjs',
    '.project/plans/2026-10-17-coordination/qa/baselines/ui.json',
    '.project/plans/audit/briefs/worker.md',
    '.project/plans/audit/lanes/verify/config.json',
    '.project/scripts/worker.mjs'];
  for (const path of [timeline, ...inputs]) {
    await mkdir(join(alpha, dirname(path)), { recursive: true });
    await writeFile(join(alpha, path), 'initial\n');
  }
  await mkdir(beta);
  const sessionName = `happier-timeline-${process.pid}`;
  const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: '', MUTAGEN_DATA_DIRECTORY: fixture.path('mutagen-data') };
  let writer;
  t.after(async () => {
    if (writer && writer.exitCode === null && writer.signalCode === null) {
      const exited = once(writer, 'exit');
      writer.kill('SIGTERM');
      await exited;
    }
    spawnSync('mutagen', ['sync', 'terminate', sessionName], { env });
    spawnSync('mutagen', ['daemon', 'stop'], { env });
    if (process.platform !== 'win32') {
      await rm(`/tmp/happier-sync-control-${process.getuid()}${fixture.root}`, { recursive: true, force: true });
    }
    await fixture.cleanup();
  });
  const rendered = renderMutagenProject({ sourceDir: alpha, targets: [] });
  const ignores = rendered.split('\n').filter(line => line.startsWith('        - ')).map(line => JSON.parse(line.slice(10)));
  runMutagen(['sync', 'create', '--name', sessionName, '--no-global-configuration', '--sync-mode=one-way-replica',
    '--watch-mode=no-watch', ...ignores.flatMap(path => ['--ignore', path]), alpha, beta], env);
  writer = spawn(process.execPath, ['--input-type=module', '-e',
    'import { appendFileSync } from "node:fs"; appendFileSync(process.argv[1], "append\\n"); process.stdout.write("ready\\n"); setInterval(() => appendFileSync(process.argv[1], "append\\n"), 5);',
    join(alpha, timeline)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(writer.stdout, 'data');
  for (const revision of ['first', 'second']) {
    for (const path of inputs) await writeFile(join(alpha, path), revision);
    const result = spawnSync(controlExecutable, ['--sync-flush', sessionName, '--', 'mutagen', 'sync', 'flush', sessionName], { env, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(readFile(join(beta, timeline)), { code: 'ENOENT' });
    for (const path of inputs) assert.equal(await readFile(join(beta, path), 'utf8'), revision);
  }
  assert.ok((await readFile(join(alpha, timeline), 'utf8')).length > 'initial\nappend\n'.length);
});

test('native sync check accepts a healthy session from the real Mutagen public template model', async (t) => {
  const root = await mkdtemp(join(mutagenFixtureParent, 'happier-dev-target-control-real-mutagen-'));
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
  assert.deepEqual(nativeFields.slice(13, 16), ['ok', '0', '0']);

  for (const content of ['written immediately before the native barrier\n', 'newer demand after the previous success\n']) {
    await writeFile(join(alpha, 'healthy.txt'), content);
    const flushed = spawnSync(controlExecutable, [
      '--sync-flush', sessionName, '--', 'mutagen', 'sync', 'flush', sessionName,
    ], { env, encoding: 'utf8' });
    assert.ifError(flushed.error);
    assert.equal(flushed.status, 0, flushed.stderr);
    assert.equal(await readFile(join(beta, 'healthy.txt'), 'utf8'), content);
  }

  // An already synchronized session must acknowledge a fresh demand even
  // when neither endpoint has changed since the previous successful barrier.
  const idleFlush = spawnSync(controlExecutable, [
    '--sync-flush', sessionName, '--', 'mutagen', 'sync', 'flush', sessionName,
  ], { env, encoding: 'utf8' });
  assert.ifError(idleFlush.error);
  assert.equal(idleFlush.status, 0, idleFlush.stderr);
  assert.equal(await readFile(join(beta, 'healthy.txt'), 'utf8'), 'newer demand after the previous success\n');

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
  assert.equal(pausedResult.stdout, '', 'paused replicas cannot publish an admission record');
});
