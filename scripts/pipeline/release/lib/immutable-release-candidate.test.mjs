import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspectImmutableReleaseCandidate } from './immutable-release-candidate.mjs';

async function fixture({
  sourceTag = 'cli-v1.2.3-preview.4',
  checksumsName = 'checksums-happier-v1.2.3-preview.4.txt',
  extraName = '',
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'immutable-release-candidate-'));
  await writeFile(join(directory, 'happier-v1.2.3-preview.4-linux-x64.tar.gz'), 'archive');
  await writeFile(
    join(directory, checksumsName),
    `${'a'.repeat(64)}  happier-v1.2.3-preview.4-linux-x64.tar.gz\n`,
  );
  await writeFile(join(directory, `${checksumsName}.minisig`), 'signature');
  if (extraName) await writeFile(join(directory, extraName), 'extra');
  return { directory, sourceTag };
}

test('binds the immutable tag, expected product/version, and complete signed envelope', async () => {
  const current = await fixture();
  try {
    const inspected = await inspectImmutableReleaseCandidate({
      directory: current.directory,
      sourceTag: current.sourceTag,
      expectedProduct: 'cli',
      expectedVersion: '1.2.3-preview.4',
    });
    assert.equal(inspected.product, 'cli');
    assert.equal(inspected.version, '1.2.3-preview.4');
    assert.equal(inspected.checksumsName, 'checksums-happier-v1.2.3-preview.4.txt');
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});

test('admits the signed desktop envelope through the same canonical inspector', async () => {
  const current = await fixture({
    sourceTag: 'ui-desktop-v1.2.3',
    checksumsName: 'checksums-happier-ui-desktop-v1.2.3.txt',
  });
  try {
    const inspected = await inspectImmutableReleaseCandidate({
      directory: current.directory,
      sourceTag: current.sourceTag,
      expectedProduct: 'ui-desktop',
      expectedVersion: '1.2.3',
    });
    assert.equal(inspected.product, 'ui-desktop');
    assert.equal(inspected.version, '1.2.3');
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});

test('rejects a mismatched product, version, checksum envelope, or unsigned extra asset', async () => {
  const wrongProduct = await fixture();
  const wrongVersion = await fixture();
  const wrongChecksums = await fixture({ checksumsName: 'checksums-hstack-v1.2.3-preview.4.txt' });
  const extra = await fixture({ extraName: 'unbound.json' });
  try {
    await assert.rejects(
      inspectImmutableReleaseCandidate({ directory: wrongProduct.directory, sourceTag: wrongProduct.sourceTag, expectedProduct: 'server' }),
      /source tag.*product|expected product/i,
    );
    await assert.rejects(
      inspectImmutableReleaseCandidate({ directory: wrongVersion.directory, sourceTag: wrongVersion.sourceTag, expectedVersion: '1.2.4' }),
      /expected version/i,
    );
    await assert.rejects(
      inspectImmutableReleaseCandidate({ directory: wrongChecksums.directory, sourceTag: wrongChecksums.sourceTag }),
      /checksums/i,
    );
    await assert.rejects(
      inspectImmutableReleaseCandidate({ directory: extra.directory, sourceTag: extra.sourceTag }),
      /unsigned|unsupported|file set/i,
    );
  } finally {
    await Promise.all([wrongProduct, wrongVersion, wrongChecksums, extra].map((entry) => (
      rm(entry.directory, { recursive: true, force: true })
    )));
  }
});
