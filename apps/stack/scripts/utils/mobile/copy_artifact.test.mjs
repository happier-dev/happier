import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { copyArtifactFile } from './copy_artifact.mjs';

test('copyArtifactFile copies a file and creates parent dirs', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-copy-artifact-'));
  try {
    const from = join(tmp, 'from.bin');
    const to = join(tmp, 'nested', 'dir', 'to.bin');
    await writeFile(from, 'hello', 'utf-8');
    await copyArtifactFile({ from, to });
    assert.equal(await readFile(to, 'utf-8'), 'hello');

    await writeFile(from, 'updated', 'utf-8');
    await copyArtifactFile({ from, to });
    assert.equal(await readFile(to, 'utf-8'), 'updated');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
