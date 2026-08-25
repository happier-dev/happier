import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';

const benchScript = new URL('./bench.mjs', import.meta.url).pathname;
const toolsScript = new URL('./tools.mjs', import.meta.url).pathname;

test('bench command executes an explicit command and reports artifact paths as JSON', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-bench-cmd-' });
  const outputDir = fixture.path('result');
  const result = await runNodeCapture([
    benchScript,
    'run',
    '--json',
    `--output-dir=${outputDir}`,
    '--label=cli-smoke',
    '--sample-interval-ms=10',
    '--warmup=1',
    '--repeat=2',
    '--',
    process.execPath,
    '-e',
    'setTimeout(() => process.exit(0), 30)',
  ], {
    cwd: fixture.root,
    env: {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: fixture.path('home'),
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.aggregate.label, 'cli-smoke');
  assert.equal(payload.aggregate.samples, 2);
  assert.equal(payload.outputDir, outputDir);
  assert.equal(JSON.parse(await readFile(`${outputDir}/aggregate.json`, 'utf8')).samples, 2);
});

test('tools help exposes the canonical bench maintainer tool', async () => {
  const result = await runNodeCapture([toolsScript, '--help', '--json'], {
    env: {
      ...process.env,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).commands.includes('bench'));
  assert.ok(JSON.parse(result.stdout).commands.includes('managed-lima'));
});
