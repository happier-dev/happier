import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  inspectImmutableReleaseCandidate,
  resolveImmutableCandidateIdentity,
} from './immutable-release-candidate.mjs';

async function fixture({
  sourceTag = 'cli-v1.2.3-preview.4',
  checksumsName = 'checksums-happier-v1.2.3-preview.4.txt',
} = {}) {
  const directory = await mkdtemp(
    join(tmpdir(), 'immutable-release-candidate-'),
  );
  await writeFile(
    join(directory, 'happier-v1.2.3-preview.4-linux-x64.tar.gz'),
    'archive',
  );
  await writeFile(
    join(directory, checksumsName),
    `${'a'.repeat(64)}  happier-v1.2.3-preview.4-linux-x64.tar.gz\n`,
  );
  await writeFile(join(directory, `${checksumsName}.minisig`), 'signature');
  return { directory, sourceTag };
}

async function withFixture(options, run) {
  const current = await fixture(options);
  try {
    await run(current);
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
}

test('derives each product tag and checksum envelope from the release product owners', () => {
  assert.deepEqual(
    {
      ...resolveImmutableCandidateIdentity({
        product: 'hstack',
        version: '1.0.0',
      }),
    },
    {
      product: 'hstack',
      version: '1.0.0',
      sourceTag: 'stack-v1.0.0',
      checksumsName: 'checksums-hstack-v1.0.0.txt',
    },
  );
  assert.equal(
    resolveImmutableCandidateIdentity({ product: 'runner', version: '2.0.0' })
      .checksumsName,
    'checksums-happier-runner-v2.0.0.txt',
  );
  assert.equal(
    resolveImmutableCandidateIdentity({
      product: 'ui-desktop',
      version: '3.0.0',
    }).sourceTag,
    'ui-desktop-v3.0.0',
  );
  assert.throws(
    () =>
      resolveImmutableCandidateIdentity({ product: 'docs', version: '1.0.0' }),
    /unsupported/,
  );
  assert.throws(
    () =>
      resolveImmutableCandidateIdentity({ product: 'cli', version: '../1' }),
    /safe/,
  );
});

test('binds an immutable tag to its own complete signed envelope', async () => {
  await withFixture({}, async (current) => {
    const inspected = await inspectImmutableReleaseCandidate(current);
    assert.equal(inspected.product, 'cli');
    assert.equal(inspected.version, '1.2.3-preview.4');
    assert.equal(
      inspected.checksumsName,
      'checksums-happier-v1.2.3-preview.4.txt',
    );
    assert.deepEqual(inspected.assetNames, [
      'happier-v1.2.3-preview.4-linux-x64.tar.gz',
    ]);
  });
  await withFixture(
    {
      sourceTag: 'ui-desktop-v1.2.3',
      checksumsName: 'checksums-happier-ui-desktop-v1.2.3.txt',
    },
    async (current) => {
      assert.equal(
        (await inspectImmutableReleaseCandidate(current)).product,
        'ui-desktop',
      );
    },
  );
});

test('admits CLI component checksum envelopes only when the main envelope signs them', async () => {
  await withFixture({}, async (current) => {
    const name = 'checksums-happier-memory-runtime-v1.2.3-preview.4.txt';
    for (const asset of [name, `${name}.minisig`]) {
      await writeFile(join(current.directory, asset), 'component envelope');
      await appendFile(
        join(current.directory, 'checksums-happier-v1.2.3-preview.4.txt'),
        `${'b'.repeat(64)}  ${asset}\n`,
      );
    }
    assert.ok(
      (await inspectImmutableReleaseCandidate(current)).assetNames.includes(
        name,
      ),
    );
    await writeFile(
      join(
        current.directory,
        'checksums-happier-difftastic-v1.2.3-preview.4.txt',
      ),
      'unsigned',
    );
    await assert.rejects(
      inspectImmutableReleaseCandidate(current),
      /unsigned assets/,
    );
  });
});

test('rejects another product envelope, unsigned extras, competing envelopes and non-file entries', async () => {
  await withFixture(
    { checksumsName: 'checksums-hstack-v1.2.3-preview.4.txt' },
    async (current) => {
      await assert.rejects(
        inspectImmutableReleaseCandidate(current),
        /missing checksums-happier-v1\.2\.3-preview\.4\.txt/,
      );
    },
  );
  await withFixture({}, async (current) => {
    await writeFile(join(current.directory, 'latest.json'), '{}');
    await assert.rejects(
      inspectImmutableReleaseCandidate(current),
      /unsigned assets: latest\.json/,
    );
  });
  await withFixture({}, async (current) => {
    await writeFile(
      join(current.directory, 'checksums-hstack-v1.2.3-preview.4.txt'),
      'other',
    );
    await assert.rejects(
      inspectImmutableReleaseCandidate(current),
      /competing checksum envelopes/,
    );
  });
  await withFixture({}, async (current) => {
    await mkdir(join(current.directory, 'nested'));
    await assert.rejects(
      inspectImmutableReleaseCandidate(current),
      /flat regular file: nested/,
    );
  });
  await withFixture({}, async (current) => {
    await symlink(
      'happier-v1.2.3-preview.4-linux-x64.tar.gz',
      join(current.directory, 'alias.tar.gz'),
    );
    await assert.rejects(
      inspectImmutableReleaseCandidate(current),
      /flat regular file: alias\.tar\.gz/,
    );
  });
  await withFixture({}, async (current) => {
    await appendFile(
      join(current.directory, 'checksums-happier-v1.2.3-preview.4.txt'),
      `${'c'.repeat(64)}  ../escape\n`,
    );
    await assert.rejects(
      inspectImmutableReleaseCandidate(current),
      /unsafe asset name/,
    );
  });
});
