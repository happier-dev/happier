import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { copyArtifactFile } from './copy_artifact.mjs';

test('copyArtifactFile copies a file and creates parent dirs', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-copy-artifact-'));
  try {
    const from = join(tmp, 'from.bin');
    const to = join(tmp, 'nested', 'dir', 'to.bin');
    await writeFile(from, 'hello', 'utf-8');
    await mkdir(dirname(to), { recursive: true });
    // Ensure the function works even if the directory already exists.

    await copyArtifactFile({ from, to });

    assert.equal(await readFile(to, 'utf-8'), 'hello');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
