import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptPath = fileURLToPath(new URL('./validateNodeNextConsumer.mjs', import.meta.url));

test('the SDK consumer validator defaults to current source without npm pack or install', async () => {
  const emptyBin = await mkdtemp(join(tmpdir(), 'happier-sdk-validator-empty-bin-'));
  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, PATH: emptyBin },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /npm (?:pack|install)/u);
  } finally {
    await rm(emptyBin, { recursive: true, force: true });
  }
});

test('the SDK consumer validator rejects a missing supplied tarball before it can repack source', async () => {
  const emptyBin = await mkdtemp(join(tmpdir(), 'happier-sdk-validator-empty-bin-'));
  const missingTarball = join(emptyBin, 'candidate.tgz');
  try {
    const result = spawnSync(process.execPath, [scriptPath, '--tarball', missingTarball], {
      env: {
        ...process.env,
        PATH: emptyBin,
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /SDK consumer tarball does not exist/u,
    );
  } finally {
    await rm(emptyBin, { recursive: true, force: true });
  }
});

test('the SDK consumer validator uses a supplied exact tarball instead of packing source again', async () => {
  const emptyBin = await mkdtemp(join(tmpdir(), 'happier-sdk-validator-empty-bin-'));
  const suppliedTarball = join(emptyBin, 'candidate.tgz');
  try {
    await writeFile(suppliedTarball, 'not-a-real-tarball');
    const result = spawnSync(process.execPath, [scriptPath, '--tarball', suppliedTarball], {
      env: {
        ...process.env,
        PATH: emptyBin,
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /npm install/u);
    assert.doesNotMatch(output, /npm pack/u);
  } finally {
    await rm(emptyBin, { recursive: true, force: true });
  }
});
