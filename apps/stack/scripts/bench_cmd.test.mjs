import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

test('bench catalog exposes named reproducible workloads without executing them', async () => {
  const result = await runNodeCapture([benchScript, 'catalog', '--json'], {
    env: {
      ...process.env,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.workloads.some((workload) => workload.id === 'metadata-rg-files'));
  assert.ok(payload.workloads.some((workload) => workload.sourceRequirement === 'git-index'));
});

test('bench run executes a named workload with catalog measurement defaults', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-bench-workload-' });
  await mkdir(fixture.path('apps'), { recursive: true });
  await mkdir(fixture.path('packages'), { recursive: true });
  await writeFile(fixture.path('apps', 'app.ts'), 'export {};\n');
  await writeFile(fixture.path('packages', 'package.ts'), 'export {};\n');
  const outputDir = fixture.path('result');
  const result = await runNodeCapture([
    benchScript,
    'run',
    '--json',
    '--workload=metadata-find-source',
    '--concurrency=2',
    '--warmup=0',
    '--repeat=1',
    `--output-dir=${outputDir}`,
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
  assert.equal(payload.aggregate.label, 'metadata-find-source');
  assert.equal(payload.aggregate.samples, 1);
  assert.equal(payload.aggregate.concurrency, 2);
});
