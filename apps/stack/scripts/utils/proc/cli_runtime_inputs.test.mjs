import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readHappyCliRuntimeInputFreshness } from './cli_runtime_inputs.mjs';

test('dedicated build checkout preserves the producer consumed-input identity', async () => {
  await withTempRepo(async (root) => {
    const producer = join(root, 'producer');
    const worker = join(root, 'worker');
    for (const repo of [producer, worker]) {
      await mkdir(join(repo, 'apps/cli/src'), { recursive: true });
      await writeFile(join(repo, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
      await writeFile(join(repo, 'apps/cli/src/index.ts'), 'export const value = 1;');
    }
    const original = await readHappyCliRuntimeInputFreshness(join(producer, 'apps/cli'));
    const inputEntries = {};
    const relocated = await readHappyCliRuntimeInputFreshness(join(worker, 'apps/cli'), { identityRepoDir: producer, inputEntries });
    assert.equal(relocated.fingerprint, original.fingerprint);
    assert.ok(inputEntries['apps/cli/src/index.ts'], 'capture diagnostics name the consumed repo-relative file');
    const beforeEntry = inputEntries['apps/cli/src/index.ts'];
    await writeFile(join(worker, 'apps/cli/src/index.ts'), 'export const value = 2;');
    assert.notEqual((await readHappyCliRuntimeInputFreshness(join(worker, 'apps/cli'), { identityRepoDir: producer, inputEntries })).fingerprint, original.fingerprint);
    assert.notEqual(inputEntries['apps/cli/src/index.ts'], beforeEntry);
  });
});

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

test('CLI runtime identity includes a workspace dependency build script', async () => {
  await withTempRepo(async (root) => {
    const cliDir = join(root, 'apps', 'cli');
    const protocolDir = join(root, 'packages', 'protocol');
    await mkdir(join(cliDir, 'src'), { recursive: true });
    await mkdir(join(protocolDir, 'scripts'), { recursive: true });
    await writeFile(join(cliDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      bundledDependencies: ['@happier-dev/protocol'],
      dependencies: { '@happier-dev/protocol': '0.0.0' },
    }), 'utf-8');
    await writeFile(join(protocolDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/protocol',
    }), 'utf-8');
    const scriptPath = join(protocolDir, 'scripts', 'generate.mjs');
    await writeFile(scriptPath, 'export const policy = 1;\n', 'utf-8');
    const before = await readHappyCliRuntimeInputFreshness(cliDir);
    await writeFile(scriptPath, 'export const policy = 2;\n', 'utf-8');
    const after = await readHappyCliRuntimeInputFreshness(cliDir);
    assert.notEqual(after.fingerprint, before.fingerprint);
  });
});
