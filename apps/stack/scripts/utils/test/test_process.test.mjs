import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

import { buildNodeTestArgs, runNodeTestFiles } from './test_process.mjs';

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

test('managed test lane cancellation stops children before deleting their isolated cache root', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t);
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
      const result = await runNodeTestFiles([${JSON.stringify(file)}], { env: { ...process.env, HAPPIER_STACK_TEST_ISOLATED_ROOT: fixture.root }, stdio: 'ignore' });
      process.exitCode = result.ok ? result.code ?? 143 : 1;
    } finally { fixture.cleanup(); }
  `], { env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: ['ignore', 'pipe', 'pipe'] });
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
