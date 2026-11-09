import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { resolveHeavyweightMemoryFloorKiB } from '../dev_targets/remote_commands.mjs';

import { buildNodeTestArgs, runNodeTestFiles, runStackTestFiles } from './test_process.mjs';

test('buildNodeTestArgs preserves native node --test file execution for unit lanes', () => {
  assert.deepEqual(buildNodeTestArgs(['/tmp/a.test.mjs', '/tmp/b.test.mjs']), [
    '--test',
    '/tmp/a.test.mjs',
    '/tmp/b.test.mjs',
  ]);
});

test('buildNodeTestArgs adds serial concurrency flag only when requested', () => {
  assert.deepEqual(buildNodeTestArgs(['/tmp/a.integration.test.mjs'], { serial: true }), [
    '--test',
    '--test-concurrency=1',
    '/tmp/a.integration.test.mjs',
  ]);
});

test('managed native test execution preserves the test runner result', async t => {
  const { root } = await createTempFixture(t);
  const file = join(root, 'result.test.mjs');
  await writeFile(file, "import test from 'node:test'; test('fixture failure', () => { throw new Error('expected failure'); });");
  // This fixture starts an independent runner, not another worker belonging to
  // the enclosing node:test process (whose private context is inherited).
  const result = await runNodeTestFiles([file], { env: { ...process.env, NODE_TEST_CONTEXT: undefined }, serial: true, stdio: 'ignore' });
  assert.equal(result.ok, true);
  assert.equal(result.code, 1);
});

test('Stack suite admission covers a nested source bundle when no capacity remains for enlargement', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t);
  const { launcher } = await installNativeAdmissionFixture({ root: fixture.root });
  const memory = fixture.path('memory');
  const floor = resolveHeavyweightMemoryFloorKiB('source-bundle');
  await writeFile(memory, `${floor} ${floor}\n`);
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const file = fixture.path('nested.test.mjs');
  const observed = fixture.path('result.json');
  await writeFile(file, `
    import test from 'node:test';
    import { spawnSync } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    test('nested source build', () => {
      // Model a peer consuming the remaining physical memory after this
      // suite was admitted. Already-covered work must still proceed.
      writeFileSync(${JSON.stringify(memory)}, '0 ${floor}\\n');
      const nested = spawnSync('/bin/sh', [${JSON.stringify(launcher)},
        '--heavyweight-admission', '--class=source-bundle', '--machine=worker', '--',
        process.execPath, '-e', ''], { encoding: 'utf8' });
      writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ status: nested.status, stderr: nested.stderr }));
    });
  `);
  const result = await runStackTestFiles([file], {
    admission: { launcherPath: launcher },
    env: { ...buildNativeAdmissionFixtureEnv(), NODE_TEST_CONTEXT: undefined,
      PATH: `${fixture.path('bin')}:${dirname(process.execPath)}:${process.env.PATH}`,
      FIXTURE_MEMORY: memory },
    stdio: 'ignore',
  });
  assert.equal(result.code, 0);
  const nested = JSON.parse(await readFile(observed, 'utf8'));
  assert.equal(nested.status, 0, nested.stderr);
});

test('managed native test execution admits the finite payload after coordinator preparation', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t);
  const admission = await installNativeAdmissionFixture({ root: fixture.root });
  const file = fixture.path('admitted.test.mjs');
  await writeFile(file, "import test from 'node:test'; import assert from 'node:assert/strict'; test('admitted payload', () => { assert.ok(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN); });");
  const result = await runNodeTestFiles([file], {
    env: { ...process.env, CI: '1', NODE_TEST_CONTEXT: undefined,
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '',
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '[]' },
    admission: { launcherPath: admission.launcher, admissionClass: 'validation' },
    serial: true, stdio: 'ignore',
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 0, 'the real native payload must execute under its own admission');
});

for (const admitted of [false, true]) test(`managed ${admitted ? 'admitted ' : ''}test lane cancellation stops children before deleting their isolated cache root`, { skip: process.platform === 'win32' || (admitted && process.platform !== 'linux') }, async t => {
  const { root } = await createTempFixture(t);
  const admission = admitted ? await installNativeAdmissionFixture({ root }) : null;
  const file = join(root, 'pending.test.mjs');
  await writeFile(file, `
    import test from 'node:test';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    mkdirSync(join(process.env.HAPPIER_STACK_TEST_ISOLATED_ROOT, 'cache'));
    writeFileSync(join(process.env.HAPPIER_STACK_TEST_ISOLATED_ROOT, 'ready'), 'ready');
    test('pending', () => new Promise(() => { setInterval(() => {}, 1000); }));
  `);
  const runner = new URL('./test_process.mjs', import.meta.url).href;
  const temporary = new URL('../../../../../scripts/testing/process/temporaryDirectories.mjs', import.meta.url).href;
  const controller = spawn(process.execPath, ['--input-type=module', '-e', `
    import { runNodeTestFiles } from ${JSON.stringify(runner)};
    import { createTestTempDirectory } from ${JSON.stringify(temporary)};
    const fixture = createTestTempDirectory('happier-stack-unit-', ${JSON.stringify(root)});
    console.log(fixture.root);
    try {
      const result = await runNodeTestFiles([${JSON.stringify(file)}], {
        admission: ${admission ? JSON.stringify({ launcherPath: admission.launcher, admissionClass: 'validation' }) : 'undefined'},
        env: { ...process.env, HAPPIER_STACK_TEST_ISOLATED_ROOT: fixture.root }, stdio: 'ignore' });
      process.exitCode = result.ok ? result.code ?? 143 : 1;
    } finally { fixture.cleanup(); }
  `], { env: { ...process.env, NODE_TEST_CONTEXT: undefined,
    ...(admitted ? { HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '',
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '',
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '[]' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => controller.kill('SIGKILL'));
  let output = '', error = '';
  controller.stdout.on('data', chunk => { output += chunk; });
  controller.stderr.on('data', chunk => { error += chunk; });
  const closed = once(controller, 'close');
  let ready = false;
  for (let attempt = 0; attempt < 250; attempt++) {
    if (output.includes('\n')) {
      ready = await access(join(output.trim(), 'ready')).then(() => true, () => false);
      if (ready) break;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(ready, error || 'test lane did not enter its payload');
  controller.kill('SIGTERM');
  const [code, signal] = await closed;
  // Native node:test may report the interrupted worker as a test failure
  // before its runner receives TERM. Both outcomes must fail the lane.
  assert.notEqual(code, 0, error);
  assert.equal(signal, null, error);
  await assert.rejects(access(output.trim()), { code: 'ENOENT' });
});
