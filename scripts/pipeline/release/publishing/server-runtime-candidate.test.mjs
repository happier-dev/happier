import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

import {
  SERVER_RUNTIME_CANDIDATE_MAX_AGGREGATE_BYTES,
  SERVER_RUNTIME_CANDIDATE_MAX_FILE_BYTES,
  finalizeServerRuntimeCandidate,
  inspectServerRuntimeCandidate,
} from './server-runtime-candidate.mjs';

test('default candidate budgets admit five self-contained migration archives without weakening the per-file cap', () => {
  assert.equal(SERVER_RUNTIME_CANDIDATE_MAX_FILE_BYTES, 512 * 1024 * 1024);
  assert.equal(SERVER_RUNTIME_CANDIDATE_MAX_AGGREGATE_BYTES, 2 * 1024 * 1024 * 1024);
});

const targets = [
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['darwin', 'x64'],
  ['darwin', 'arm64'],
  ['windows', 'x64'],
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'server-runtime-candidate-'));
  const version = '1.2.3-preview.4';
  for (const [os, arch] of targets) {
    await writeFile(join(root, `happier-server-v${version}-${os}-${arch}.tar.gz`), `${os}-${arch}`);
  }
  return { root, version };
}

test('accepts exactly the expected opaque server runtime archives as regular files', async () => {
  const { root, version } = await fixture();
  const inspected = await inspectServerRuntimeCandidate({ candidateDir: root, version, maxFileBytes: 1024 });
  assert.equal(inspected.artifacts.length, 5);
  assert.deepEqual(inspected.artifacts.map((entry) => entry.name), targets.map(([os, arch]) =>
    `happier-server-v${version}-${os}-${arch}.tar.gz`).sort());
});

test('rejects extra files, missing files, symlinks, and oversized files', async (t) => {
  await t.test('extra file', async () => {
    const { root, version } = await fixture();
    await writeFile(join(root, 'run-me.sh'), '#!/bin/sh\n');
    await assert.rejects(inspectServerRuntimeCandidate({ candidateDir: root, version }), /unexpected candidate file/i);
  });
  await t.test('missing file', async () => {
    const { root, version } = await fixture();
    const { rm } = await import('node:fs/promises');
    await rm(join(root, `happier-server-v${version}-linux-x64.tar.gz`));
    await assert.rejects(inspectServerRuntimeCandidate({ candidateDir: root, version }), /candidate file set mismatch/i);
  });
  await t.test('symlink', async () => {
    const { root, version } = await fixture();
    const name = `happier-server-v${version}-linux-x64.tar.gz`;
    const { rm } = await import('node:fs/promises');
    await rm(join(root, name));
    await symlink('/etc/passwd', join(root, name));
    await assert.rejects(inspectServerRuntimeCandidate({ candidateDir: root, version }), /regular file|symbolic link/i);
  });
  await t.test('oversized', async () => {
    const { root, version } = await fixture();
    await assert.rejects(inspectServerRuntimeCandidate({ candidateDir: root, version, maxFileBytes: 2 }), /size/i);
  });
  await t.test('aggregate size limit', async () => {
    const { root, version } = await fixture();
    await assert.rejects(
      inspectServerRuntimeCandidate({
        candidateDir: root,
        version,
        maxFileBytes: 1024,
        maxAggregateBytes: 10,
      }),
      /aggregate.*size/i,
    );
  });
});

test('trusted finalization requires an externally authorized full SHA and recomputes checksums', async () => {
  const { root, version } = await fixture();
  const outDir = join(root, '..', 'final');
  await assert.rejects(finalizeServerRuntimeCandidate({
    candidateDir: root,
    outDir,
    version,
    authorizedSha: 'main',
    sign: async () => {},
  }), /authorized SHA/i);

  const finalized = await finalizeServerRuntimeCandidate({
    candidateDir: root,
    outDir,
    version,
    authorizedSha: 'a'.repeat(40),
    sign: async (checksumsPath) => writeFile(`${checksumsPath}.minisig`, 'trusted-signature'),
  });
  assert.equal(finalized.authorizedSha, 'a'.repeat(40));
  assert.equal(finalized.artifacts.length, 5);
  assert.match(finalized.checksums, /^[a-f0-9]{64}  happier-server-v/m);
});
