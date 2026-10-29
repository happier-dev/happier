import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateProcessTreeByPid } from '../../../scripts/testing/process/processTree.mjs';

import {
  buildVitestShardRunArgs,
  classifyVitestShardTermination,
  resolveVitestConfigPath,
  resolveVitestPassthroughArgs,
  resolveVitestPositionalFilters,
  resolveVitestShardCountForFileCount,
  resolveVitestShardConcurrency,
  resolveVitestShardRange,
  resolveVitestShardTimeoutMs,
} from './runVitestShards.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptsDir);
const runnerPath = join(scriptsDir, 'runVitestShards.mjs');

const realRepo = process.env.CI03_REAL_REPO ?? resolve(packageRoot, '../..');

test('eight real unit invocations cover each file once and respect the canonical worker budget', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ci03-eight-ui-seam-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(join(realRepo, 'node_modules'), join(root, 'node_modules'), 'dir');
  const config = join(root, 'vitest.config.mjs');
  await writeFile(config, 'export default { test: { include: ["**/*.test.mjs"], maxWorkers: 2, minWorkers: 1 } };');
  for (let index = 0; index < 16; index++) {
    await writeFile(join(root, `case-${index}.test.mjs`), `import {test, expect} from "vitest"; test("case ${index}", () => expect(true).toBe(true));`);
  }
  const run = (part, extraEnv = {}) => {
    const output = join(root, `part-${part}.json`);
    const result = spawnSync(process.execPath, [runnerPath, '--config', config, '--reporter=json', `--outputFile=${output}`], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HAPPIER_UI_VITEST_PART: String(part), HAPPIER_UI_VITEST_PARTS: '8',
        HAPPIER_VITEST_MAX_WORKERS: '2', VITEST_MAX_FORKS: '2', VITEST_MIN_FORKS: '1', ...extraEnv },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return output;
  };
  const files = [];
  for (let part = 1; part <= 8; part++) {
    const report = JSON.parse(await readFile(run(part), 'utf8'));
    files.push(...report.testResults.map(row => row.name));
  }
  assert.equal(files.length, 16, 'the matrix must not replay the whole suite in every partition');
  assert.equal(new Set(files).size, 16, 'no file may be duplicated or omitted');
  for (let index = 0; index < 16; index++) {
    await writeFile(join(root, `case-${index}.test.mjs`), 'import {test, expect} from "vitest"; test("worker binding", () => expect(process.env.VITEST_MAX_FORKS).toBe("2"));');
  }
  run(1, { VITEST_MAX_FORKS: '9' });
});

test('loaded resource owners finish cleanup within the containing hook and the real worker exits', async (t) => {
  const fixtureParent = resolve(packageRoot, '../../.project/tmp');
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(join(fixtureParent, 'vitest-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'cleanup.json');
  const fixture = join(root, 'cleanup.test.ts');
  const config = join(root, 'vitest.config.mjs');
  await writeFile(config, `import base from ${JSON.stringify(join(packageRoot, 'vitest.config.ts'))};
export default { ...base, root: ${JSON.stringify(root)}, test: { ...base.test, include: ['cleanup.test.ts'], maxWorkers: 1, minWorkers: 1 } };\n`);
  await writeFile(fixture, `import { it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
it('registers a live resource with its owning cleanup', () => {
  const resource = setInterval(() => {}, 1000);
  const registry = globalThis[Symbol.for('happier.vitest.runtimeCleanups')];
  expect(registry).toBeInstanceOf(Map);
  registry.set('fixture-resource', async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
    clearInterval(resource);
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ released: true }));
  });
});\n`);
  const result = spawnSync(process.execPath, [
    resolve(packageRoot, '../../node_modules/vitest/vitest.mjs'), 'run', '--config', config,
  ], {
    cwd: packageRoot, encoding: 'utf8',
    env: { ...process.env, HAPPIER_VITEST_AFTERALL_CLEANUP_TIMEOUT_MS: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { released: true });
});

const wrapper = fileURLToPath(new URL('./withNodeHeapLimit.mjs', import.meta.url));
const probe = 'console.log(JSON.stringify({heap: require("node:v8").getHeapStatistics().heap_size_limit, flags: process.env.NODE_OPTIONS}))';

test('the real wrapper preserves Node allocation and explicit executor or UI overrides', () => {
  for (const scenario of [
    { NODE_OPTIONS: '--trace-warnings' },
    { NODE_OPTIONS: '--trace-warnings --max-old-space-size=12288', HAPPIER_UI_TEST_MAX_OLD_SPACE_SIZE_MB: '8192' },
    { NODE_OPTIONS: '--trace-warnings', HAPPIER_UI_TEST_MAX_OLD_SPACE_SIZE_MB: '12288' },
  ]) {
    const env = { ...process.env, ...scenario };
    if (!Object.hasOwn(scenario, 'HAPPIER_UI_TEST_MAX_OLD_SPACE_SIZE_MB')) delete env.HAPPIER_UI_TEST_MAX_OLD_SPACE_SIZE_MB;
    const directEnv = { ...env, NODE_OPTIONS: scenario.NODE_OPTIONS.includes('--max-old-space-size')
      ? scenario.NODE_OPTIONS
      : `${scenario.NODE_OPTIONS}${scenario.HAPPIER_UI_TEST_MAX_OLD_SPACE_SIZE_MB ? ` --max-old-space-size=${scenario.HAPPIER_UI_TEST_MAX_OLD_SPACE_SIZE_MB}` : ''}` };
    const direct = spawnSync(process.execPath, ['-e', probe], { env: directEnv, encoding: 'utf8' });
    const wrapped = spawnSync(process.execPath, [wrapper, process.execPath, '-e', probe], { env, encoding: 'utf8' });
    for (const child of [direct, wrapped]) {
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
    }
    assert.deepEqual(JSON.parse(wrapped.stdout), JSON.parse(direct.stdout));
  }
});

test('partition admission accounts for each transform server and its full canonical fork pool', () => {
  assert.equal(resolveVitestShardConcurrency({}, ['--concurrency=8'], 12, 4), 2);
  assert.equal(resolveVitestShardConcurrency({}, ['--concurrency=8'], 48, 4), 8);
  assert.equal(resolveVitestShardConcurrency({ HAPPIER_UI_VITEST_SHARD_CONCURRENCY: '8' }, [], 4, 2), 1);
  assert.equal(resolveVitestShardConcurrency({}, ['--concurrency=8'], 1, 1), 1);
  assert.equal(resolveVitestShardConcurrency({}, [], 48, 4), 1);
  assert.equal(resolveVitestShardConcurrency({}, ['--concurrency=8'], 12, 1), 6);
});

test('the containing job owns the default deadline while explicit diagnostic watchdogs remain available', () => {
  assert.equal(resolveVitestShardTimeoutMs({}), undefined);
  assert.equal(resolveVitestShardTimeoutMs({ HAPPIER_UI_VITEST_SHARD_TIMEOUT_MS: 'invalid' }), undefined);
  assert.equal(resolveVitestShardTimeoutMs({ HAPPIER_UI_VITEST_SHARD_TIMEOUT_MS: '5000' }), 5000);
  assert.deepEqual(classifyVitestShardTermination({ code: null, signal: 'SIGTERM', timedOut: true }), {
    outcome: 'failed', exitCode: 124, signal: 'SIGTERM', timedOut: true,
  });
});

test('CI parts balance the configured shard range', () => {
  assert.deepEqual(resolveVitestShardRange({ HAPPIER_UI_VITEST_PART: '1', HAPPIER_UI_VITEST_PARTS: '4' }, 32),
    { start: 1, end: 8, part: 1, parts: 4 });
  assert.deepEqual(resolveVitestShardRange({ HAPPIER_UI_VITEST_PART: '4', HAPPIER_UI_VITEST_PARTS: '4' }, 32),
    { start: 25, end: 32, part: 4, parts: 4 });
  assert.deepEqual(resolveVitestShardRange({}, 32), { start: 1, end: 32, part: 1, parts: 1 });
});

test('valid concurrency is bounded by allocation and argv takes precedence over env', () => {
  assert.equal(resolveVitestShardConcurrency({ HAPPIER_UI_VITEST_SHARD_CONCURRENCY: '3' }, [], 12, 4), 2);
  assert.equal(resolveVitestShardConcurrency({ HAPPIER_UI_VITEST_SHARD_CONCURRENCY: '3' }, [], 48, 4), 3);
  for (const invalid of ['0', 'nope']) {
    assert.equal(resolveVitestShardConcurrency({ HAPPIER_UI_VITEST_SHARD_CONCURRENCY: invalid }, [], 12, 4), 1);
  }
  assert.equal(resolveVitestShardConcurrency({ HAPPIER_UI_VITEST_SHARD_CONCURRENCY: '2' }, ['--concurrency', '4'], 48, 4), 4);
  assert.equal(resolveVitestShardConcurrency({}, ['--concurrency=5'], 48, 4), 5);
  assert.equal(resolveVitestShardConcurrency({}, ['--concurrency=5'], 12, 4), 2);
});

test('config and runner concurrency are consumed without losing Vitest arguments', () => {
  assert.equal(resolveVitestConfigPath(['node', 'run', '--config', 'vitest.config.ts']), 'vitest.config.ts');
  assert.equal(resolveVitestConfigPath(['node', 'run']), null);
  assert.deepEqual(resolveVitestPassthroughArgs([
    'node', 'run', '--config', 'vitest.config.ts', '--concurrency', '3', 'sources/dev/runVitestShards.test.ts', '--reporter', 'dot',
  ]), ['sources/dev/runVitestShards.test.ts', '--reporter', 'dot']);
});

for (const scenario of [
  { name: 'legacy UI budget', env: { VITEST_UI_MAX_FORKS: '1' }, args: [], workers: 1 },
  { name: 'caller worker arguments', env: { HAPPIER_VITEST_MAX_WORKERS: '2' }, args: ['--maxWorkers=1', '--minWorkers=1'], workers: 1 },
  { name: 'native percentage worker arguments', env: {}, args: ['--maxWorkers=50%', '--minWorkers=1'], workers: Math.max(1, Math.floor(availableParallelism() / 2)) },
  { name: 'caller minimum worker arguments', env: {}, args: ['--maxWorkers=2', '--minWorkers=2'], workers: 2, minWorkers: 2 },
  { name: 'shared override precedence', env: { HAPPIER_VITEST_MAX_WORKERS: '2', VITEST_UI_MAX_FORKS: '1' }, args: [], workers: 2 },
  { name: 'explicit legacy allocation above six', env: { VITEST_UI_MAX_FORKS: '9' }, args: [], workers: 9 },
  { name: 'invalid supplied budget through canonical config', env: { HAPPIER_VITEST_MAX_WORKERS: 'invalid' }, args: [], workers: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))) },
  { name: 'selected-file worker budget', partition: false, env: { HAPPIER_VITEST_MAX_WORKERS: '2', VITEST_UI_MAX_FORKS: '1' }, args: [], workers: 2 },
  { name: 'parallel partitions include transform-server CPU', env: {}, args: ['--concurrency=8'], shards: 8, fileCount: 16,
    workers: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))) },
  { name: 'parallel native minimum worker arguments', env: { HAPPIER_VITEST_MAX_WORKERS: '2' },
    args: ['--concurrency=8', '--minWorkers=2'], shards: 8, fileCount: 16, workers: 2, minWorkers: 2 },
]) {
  test(`${scenario.partition === false ? 'ordinary UI' : 'Gate'} honors ${scenario.name}`, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'happier-ui-vitest-budget-'));
    try {
      const configPath = join(tempRoot, 'vitest.config.mjs');
      const reporterPath = join(tempRoot, 'reporter.mjs');
      const recordPath = join(tempRoot, 'pool.json');
      await writeFile(reporterPath, `import { writeFileSync } from 'node:fs'; export default class { onInit(ctx) { writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ maxWorkers: ctx.config.poolOptions?.forks?.maxForks ?? ctx.config.maxWorkers, minWorkers: ctx.config.poolOptions?.forks?.minForks ?? ctx.config.minWorkers })); } }\n`);
      await writeFile(configPath, `import { resolveVitestWorkers } from ${JSON.stringify(join(packageRoot, '../../scripts/testing/vitestWorkers.ts'))}; export default { root: ${JSON.stringify(tempRoot)}, test: { include: ['*.test.js'], pool: 'forks', ...resolveVitestWorkers({ legacyUiOverride: true }), reporters: [${JSON.stringify(reporterPath)}] } };\n`);
      await writeFile(join(tempRoot, 'pool.test.js'), "import { test, expect } from 'vitest'; test('real pool admission', () => expect(true).toBe(true));\n");
      for (let index = 1; index < (scenario.fileCount ?? 1); index += 1) {
        await writeFile(join(tempRoot, `pool-${index}.test.js`), "import { test, expect } from 'vitest'; test('real pool admission', () => expect(true).toBe(true));\n");
      }
      const env = { ...process.env, CI: 'true', HAPPIER_UI_VITEST_PART: scenario.partition === false ? '' : '1', HAPPIER_UI_VITEST_PARTS: scenario.partition === false ? '' : '1', HAPPIER_UI_VITEST_SHARDS: String(scenario.shards ?? 1), VITEST_MAX_FORKS: '13', VITEST_MAX_THREADS: '13', VITEST_MIN_FORKS: '1', VITEST_MIN_THREADS: '1' };
      delete env.HAPPIER_VITEST_MAX_WORKERS;
      delete env.VITEST_UI_MAX_FORKS;
      Object.assign(env, scenario.env);
      const child = spawn(process.execPath, [runnerPath, '--config', configPath, ...scenario.args], { cwd: packageRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(code, 0, output);
      assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), { maxWorkers: scenario.workers, minWorkers: scenario.minWorkers ?? 1 });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
}

test('the file-count shard resolver keeps each Vitest process within the file budget', () => {
  assert.equal(resolveVitestShardCountForFileCount({}, 1_264), 10);
  assert.equal(resolveVitestShardCountForFileCount({}, 1), 1);
  assert.equal(resolveVitestShardCountForFileCount({}, 128), 1);
  assert.equal(resolveVitestShardCountForFileCount({}, 129), 2);
  assert.equal(resolveVitestShardCountForFileCount({}, 5_056), 40);
});

for (const interruption of ['SIGINT', 'timeout']) {
  test(`the selected partition cleans its real worker on ${interruption}`, {
    skip: interruption === 'SIGINT' && process.platform === 'win32',
  }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'happier-ui-vitest-gate-stop-'));
    let child;
    try {
      const configPath = join(tempRoot, 'vitest.config.mjs');
      await writeFile(configPath, `export default { root: ${JSON.stringify(tempRoot)}, test: { include: ['*.test.js'], pool: 'forks', isolate: true, testTimeout: 60000 } };\n`);
      await writeFile(join(tempRoot, 'waiting.test.js'), "import { test } from 'vitest'; test('native Gate interruption', async () => { console.log('GATE_READY:' + process.pid); await new Promise(() => {}); });\n");
      child = spawn(process.execPath, [runnerPath, '--config', configPath], {
        cwd: packageRoot,
        env: { ...process.env, CI: 'true', HAPPIER_UI_VITEST_PART: '1', HAPPIER_UI_VITEST_PARTS: '1', HAPPIER_UI_VITEST_SHARD_TIMEOUT_MS: '5000' },
        stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
      let stdout = '';
      let stderr = '';
      let workerPid;
      child.stdout.on('data', chunk => {
        stdout += chunk;
        const match = stdout.match(/GATE_READY:(\d+)/);
        if (match && workerPid === undefined) {
          workerPid = Number(match[1]);
          if (interruption === 'SIGINT') child.kill('SIGINT');
        }
      });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.ok(workerPid, `${stdout}\n${stderr}`);
      assert.equal(code, interruption === 'SIGINT' ? 130 : 124, `${stdout}\n${stderr}`);
      assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' });
    } finally {
      if (child?.pid) await terminateProcessTreeByPid(child.pid, { graceMs: 0 });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
}

test('an explicit shard count override remains authoritative', () => {
  assert.equal(resolveVitestShardCountForFileCount({ HAPPIER_UI_VITEST_SHARDS: '32' }, 5_056), 32);
});

test('the list pass keeps the caller filters that select the files', () => {
  const argv = ['node', './scripts/runVitestShards.mjs', '--config', 'vitest.config.ts', 'sources/voice'];
  assert.deepEqual(resolveVitestPassthroughArgs(argv), ['sources/voice']);
});

test('a bare-name positional filter is not forwarded into the per-shard run', async () => {
  // Vitest ORs positional filters with an explicit file list, so a filter that survives into the
  // shard invocation makes EVERY shard re-run the whole filtered set - the same file executed once
  // per shard instead of once. A bare name carries no separator and no extension,
  // which is exactly what the previous shape heuristic could not recognise.
  const passthroughArgs = ['legendListRenderer'];
  const positionalFilters = await resolveVitestPositionalFilters(passthroughArgs);
  assert.deepEqual(positionalFilters, ['legendListRenderer']);
  assert.deepEqual(
    buildVitestShardRunArgs({
      configPath: 'vitest.config.ts',
      passthroughArgs,
      positionalFilters,
      files: ['/abs/a.test.ts'],
    }),
    ['run', '--config', 'vitest.config.ts', '--file-parallelism=true', '/abs/a.test.ts'],
  );
});

test('multiple positional filters are all dropped from the shard run', async () => {
  const passthroughArgs = ['sources/voice', 'sources/voice/output/speakAssistantText.spec.ts'];
  assert.deepEqual(
    buildVitestShardRunArgs({
      configPath: 'vitest.config.ts',
      passthroughArgs,
      positionalFilters: await resolveVitestPositionalFilters(passthroughArgs),
      files: ['/abs/a.test.ts'],
    }),
    ['run', '--config', 'vitest.config.ts', '--file-parallelism=true', '/abs/a.test.ts'],
  );
});

test('option values are preserved even when spelled like the dropped filter', async () => {
  const passthroughArgs = ['--reporter', 'dot', '--testNamePattern', 'sources/voice', 'sources/voice'];
  const positionalFilters = await resolveVitestPositionalFilters(passthroughArgs);
  // Vitest's own parser knows `sources/voice` is the value of `--testNamePattern` the first time
  // and a path filter the second; a local option table could only guess.
  assert.deepEqual(positionalFilters, ['sources/voice']);
  assert.deepEqual(
    buildVitestShardRunArgs({
      configPath: 'vitest.config.ts',
      passthroughArgs,
      positionalFilters,
      files: ['/abs/a.test.ts'],
    }),
    [
      'run',
      '--config',
      'vitest.config.ts',
      '--file-parallelism=true',
      '--reporter',
      'dot',
      '--testNamePattern',
      'sources/voice',
      '/abs/a.test.ts',
    ],
  );
});

test('an unfiltered run (the CI lane shape) carries only its shard files', async () => {
  assert.deepEqual(await resolveVitestPositionalFilters([]), []);
  assert.deepEqual(
    buildVitestShardRunArgs({
      configPath: 'vitest.config.ts',
      passthroughArgs: [],
      positionalFilters: [],
      files: ['/abs/a.test.ts'],
    }),
    ['run', '--config', 'vitest.config.ts', '--file-parallelism=true', '/abs/a.test.ts'],
  );
});

test('runVitestShards launches shards without relying on PATH vitest lookup', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-ui-vitest-shards-'));
  try {
    const configPath = join(tempRoot, 'vitest.config.mjs');
    const testPath = join(tempRoot, 'pathless-runner.test.js');
    await writeFile(
      configPath,
      `export default { root: ${JSON.stringify(tempRoot)}, test: { include: ['pathless-runner.test.js'] } };\n`,
    );
    await writeFile(
      testPath,
      "import { expect, test } from 'vitest';\n\ntest('runs through the shard wrapper', () => {\n  expect(1).toBe(1);\n});\n",
    );

    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [runnerPath, '--config', configPath, testPath], {
        cwd: packageRoot,
        env: {
          ...process.env,
          CI: '1',
          HAPPIER_UI_VITEST_SHARDS: '1',
          PATH: '/usr/bin:/bin',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', (error) => {
        resolve({ code: null, signal: null, stdout, stderr: `${stderr}\n${error.message}` });
      });
      child.once('exit', (code, signal) => {
        resolve({ code, signal, stdout, stderr });
      });
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.signal, null, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /ENOENT/, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

for (const concurrency of [1, 2]) {
  test(`SIGINT stops the real shard lane and its workers at concurrency ${concurrency}`, {
    // Windows process.kill forcibly terminates the target instead of delivering a POSIX signal.
    skip: process.platform === 'win32',
  }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'happier-ui-vitest-interrupt-'));
    let child;
    try {
      const configPath = join(tempRoot, 'vitest.config.mjs');
      await writeFile(configPath, `export default { root: ${JSON.stringify(tempRoot)}, test: { include: ['*.test.js'], pool: 'forks', maxWorkers: 1 } };\n`);
      for (let index = 0; index < concurrency + 1; index += 1) {
        const body = index < concurrency
          ? `console.log('INTERRUPT_READY:${index}:' + process.pid); await new Promise(() => {});`
          : "console.log('LATER_SHARD_RAN'); expect(1).toBe(1);";
        await writeFile(join(tempRoot, `${index}.test.js`), `import { expect, test } from 'vitest';\ntest('native signal boundary', async () => { ${body} });\n`);
      }
      child = spawn(process.execPath, [runnerPath, '--config', configPath], {
        cwd: packageRoot,
        env: {
          ...process.env,
          CI: 'true',
          HAPPIER_UI_VITEST_PART: '',
          HAPPIER_UI_VITEST_PARTS: '',
          HAPPIER_UI_VITEST_SHARDS: String(concurrency + 1),
          HAPPIER_UI_VITEST_SHARD_CONCURRENCY: String(concurrency),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let stdout = '';
      let stderr = '';
      let interrupted = false;
      const workerPids = new Set();
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        for (const match of stdout.matchAll(/INTERRUPT_READY:\d+:(\d+)/g)) workerPids.add(Number(match[1]));
        if (!interrupted && workerPids.size === concurrency) {
          interrupted = true;
          child.kill('SIGINT');
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(interrupted, true, `${stdout}\n${stderr}`);
      assert.equal(result.code, 130, `${stdout}\n${stderr}`);
      assert.doesNotMatch(stdout, /LATER_SHARD_RAN/, `${stdout}\n${stderr}`);
      for (const pid of workerPids) {
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `interrupted worker ${pid} survived`);
      }
    } finally {
      if (child?.pid) await terminateProcessTreeByPid(child.pid, { graceMs: 0 });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test(`a native shard timeout closes workers, continues later shards, and fails the lane at concurrency ${concurrency}`, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'happier-ui-vitest-timeout-'));
    let child;
    try {
      const configPath = join(tempRoot, 'vitest.config.mjs');
      await writeFile(configPath, `export default { root: ${JSON.stringify(tempRoot)}, test: { include: ['*.test.js'], pool: 'forks', maxWorkers: 1, testTimeout: 60000 } };\n`);
      for (let index = 0; index < concurrency + 1; index += 1) {
        const body = index < concurrency
          ? `console.log('TIMEOUT_READY:${index}:' + process.pid); await new Promise(() => {});`
          : "console.log('LATER_SHARD_RAN'); expect(1).toBe(1);";
        await writeFile(join(tempRoot, `${index}.test.js`), `import { expect, test } from 'vitest';\ntest('native timeout boundary', async () => { ${body} });\n`);
      }
      child = spawn(process.execPath, [runnerPath, '--config', configPath], {
        cwd: packageRoot,
        env: {
          ...process.env,
          CI: 'true',
          HAPPIER_UI_VITEST_PART: '',
          HAPPIER_UI_VITEST_PARTS: '',
          HAPPIER_UI_VITEST_SHARDS: String(concurrency + 1),
          HAPPIER_UI_VITEST_SHARD_CONCURRENCY: String(concurrency),
          // The native READY measurements are below two seconds; use the existing
          // override to exercise tree cleanup before the canonical 60-second test budget.
          HAPPIER_UI_VITEST_SHARD_TIMEOUT_MS: '5000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      const workerPids = [...stdout.matchAll(/TIMEOUT_READY:\d+:(\d+)/g)].map((match) => Number(match[1]));
      assert.equal(workerPids.length, concurrency, `${stdout}\n${stderr}`);
      assert.equal(result.code, 124, `${stdout}\n${stderr}`);
      assert.match(stdout, /LATER_SHARD_RAN/, `${stdout}\n${stderr}`);
      for (const pid of workerPids) {
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `timed-out worker ${pid} survived`);
      }
    } finally {
      if (child?.pid) await terminateProcessTreeByPid(child.pid, { graceMs: 0 });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
}
