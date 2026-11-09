import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { extractBinaryFromArtifact, run, stageExtractedBinaryPayload } from './self_host_service_e2e_harness.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';

test('self-host staging retains the extracted Windows launcher beside HStack', async (t) => {
  const fixture = await createTempFixture(t);
  const payloadDir = fixture.path('payload');
  const binDir = fixture.path('bin');
  await mkdir(payloadDir);
  await mkdir(binDir);
  await writeFile(join(payloadDir, 'hstack.exe'), 'fixture HStack');
  await writeFile(join(payloadDir, 'happier-service-launcher.exe'), 'fixture launcher');
  const artifactPath = fixture.path('hstack.tar.gz');
  run('tar', ['-czf', artifactPath, '-C', fixture.root, 'payload']);

  const extracted = await extractBinaryFromArtifact({ artifactPath, binaryName: 'hstack.exe' });
  t.after(() => rm(extracted.extractDir, { recursive: true, force: true }));
  const stagedBinaryPath = await stageExtractedBinaryPayload(extracted.binaryPath, binDir);

  assert.equal(stagedBinaryPath, join(binDir, 'hstack.exe'));
  assert.equal(await readFile(stagedBinaryPath, 'utf8'), 'fixture HStack');
  assert.equal(await readFile(join(binDir, 'happier-service-launcher.exe'), 'utf8'), 'fixture launcher');
});

