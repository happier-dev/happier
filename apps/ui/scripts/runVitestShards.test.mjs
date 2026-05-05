import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveVitestPassthroughArgs,
  resolveVitestRunPassthroughArgs,
  stripTrailingPositionalFileFilters,
} from './runVitestShards.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptsDir);
const runnerPath = join(scriptsDir, 'runVitestShards.mjs');

test('resolveVitestRunPassthroughArgs strips trailing positional file filters used for vitest list', () => {
  const argv = ['node', './scripts/runVitestShards.mjs', '--config', 'vitest.config.ts', 'sources/voice'];
  assert.deepEqual(resolveVitestPassthroughArgs(argv), ['sources/voice']);
  assert.deepEqual(resolveVitestRunPassthroughArgs(argv), []);
});

test('stripTrailingPositionalFileFilters strips multiple trailing positional filters', () => {
  assert.deepEqual(stripTrailingPositionalFileFilters(['sources/voice', 'sources/voice/output/speakAssistantText.spec.ts']), []);
});

test('stripTrailingPositionalFileFilters preserves flags and their values', () => {
  assert.deepEqual(stripTrailingPositionalFileFilters(['--reporter', 'dot', 'sources/voice']), ['--reporter', 'dot']);
});

test('stripTrailingPositionalFileFilters does not strip known flag values even if they look like paths', () => {
  assert.deepEqual(stripTrailingPositionalFileFilters(['--include', 'sources/voice']), ['--include', 'sources/voice']);
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
