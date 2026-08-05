import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildVitestShardRunArgs,
  resolveVitestPassthroughArgs,
  resolveVitestPositionalFilters,
} from './runVitestShards.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptsDir);
const runnerPath = join(scriptsDir, 'runVitestShards.mjs');

test('the list pass keeps the caller filters that select the files', () => {
  const argv = ['node', './scripts/runVitestShards.mjs', '--config', 'vitest.config.ts', 'sources/voice'];
  assert.deepEqual(resolveVitestPassthroughArgs(argv), ['sources/voice']);
});

test('a bare-name positional filter is not forwarded into the per-shard run', async () => {
  // Vitest ORs positional filters with an explicit file list, so a filter that survives into the
  // shard invocation makes EVERY shard re-run the whole filtered set - the same file executed once
  // per shard (24x by default) instead of once. A bare name carries no separator and no extension,
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
    ['run', '--config', 'vitest.config.ts', '--no-file-parallelism', '/abs/a.test.ts'],
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
    ['run', '--config', 'vitest.config.ts', '--no-file-parallelism', '/abs/a.test.ts'],
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
      '--no-file-parallelism',
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
    ['run', '--config', 'vitest.config.ts', '--no-file-parallelism', '/abs/a.test.ts'],
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
