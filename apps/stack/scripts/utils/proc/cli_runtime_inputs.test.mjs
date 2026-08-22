import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readHappyCliRuntimeInputFreshness } from './cli_runtime_inputs.mjs';

async function withTempRepo(run) {
  const root = await mkdtemp(join(tmpdir(), 'happy-cli-runtime-inputs-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('readHappyCliRuntimeInputFreshness surfaces the runtime-input resolution failure instead of reporting no fingerprint', async () => {
  await withTempRepo(async (root) => {
    // A CLI directory whose package.json cannot be read is a build-configuration
    // failure, not an absent fingerprint. Callers render `freshness?.fingerprint`
    // as "must be a non-empty fingerprint", which names neither the directory nor
    // the reason, so the actionable error has to reach them.
    const cliDir = join(root, 'apps', 'cli');
    await mkdir(cliDir, { recursive: true });

    await assert.rejects(
      () => readHappyCliRuntimeInputFreshness(cliDir),
      (error) => {
        assert.match(String(error?.message ?? ''), /package\.json/);
        assert.match(String(error?.message ?? ''), /apps.cli/);
        return true;
      },
    );
  });
});

test('readHappyCliRuntimeInputFreshness still fingerprints a resolvable CLI directory', async () => {
  await withTempRepo(async (root) => {
    const cliDir = join(root, 'apps', 'cli');
    await mkdir(join(cliDir, 'src'), { recursive: true });
    await writeFile(
      join(cliDir, 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli', version: '0.0.0' }),
      'utf-8',
    );
    await writeFile(join(cliDir, 'src', 'index.ts'), 'export const value = 1;\n', 'utf-8');

    const freshness = await readHappyCliRuntimeInputFreshness(cliDir);
    assert.match(String(freshness?.fingerprint ?? ''), /^[a-f0-9]{64}$/);
    assert.ok(typeof freshness?.newestMtimeNs === 'bigint');
  });
});
