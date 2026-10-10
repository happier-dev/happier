import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readCachedFileDigestSync } from './cached_file_digest.mjs';

test('file digest reuse distinguishes replacements even on a coarse filesystem clock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-file-digest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'input.d.ts');
  await writeFile(path, 'old');
  // Filesystem clocks may assign the same timestamps to distinct inodes.
  // Substitute only that OS observation; content reads and digest logic stay real.
  const observation = async () => ({ ...await stat(path, { bigint: true }), mtimeNs: 1n, ctimeNs: 1n });
  const before = readCachedFileDigestSync(path, await observation());
  await writeFile(join(root, 'replacement'), 'new');
  await rename(join(root, 'replacement'), path);
  const after = readCachedFileDigestSync(path, await observation());
  assert.notEqual(after, before);
  assert.equal(after, createHash('sha256').update(await readFile(path)).digest('hex'));
});
