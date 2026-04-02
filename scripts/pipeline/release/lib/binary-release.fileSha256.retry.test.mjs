import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';

import { fileSha256 } from './binary-release.mjs';

test('fileSha256 retries ENOENT briefly (helps flaky release artifact FS visibility)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-binary-release-sha256-'));
  const targetPath = join(dir, 'artifact.bin');
  const bytes = Buffer.from('hello', 'utf8');
  const expected = createHash('sha256').update(bytes).digest('hex');

  try {
    // Create the file after a short delay so the first attempt would hit ENOENT.
    void (async () => {
      await delay(50);
      await writeFile(targetPath, bytes);
    })();

    const actual = await fileSha256(targetPath);
    assert.equal(actual, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

