import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildIntoTempThenReplace } from './atomic_dir_swap.mjs';

async function withTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-atomic-dir-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('buildIntoTempThenReplace preserves existing dir when build fails', async (t) => {
  const root = await withTempRoot(t);
  const outDir = join(root, 'ui');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'marker.txt'), 'old\n', 'utf-8');

  await assert.rejects(
    async () => {
      await buildIntoTempThenReplace(outDir, async (tmp) => {
        await writeFile(join(tmp, 'marker.txt'), 'new\n', 'utf-8');
        throw new Error('boom');
      });
    },
    /boom/
  );

  const after = await readFile(join(outDir, 'marker.txt'), 'utf-8');
  assert.equal(after, 'old\n');
});

test('buildIntoTempThenReplace replaces dir on success', async (t) => {
  const root = await withTempRoot(t);
  const outDir = join(root, 'ui');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'marker.txt'), 'old\n', 'utf-8');

  await buildIntoTempThenReplace(outDir, async (tmp) => {
    await writeFile(join(tmp, 'marker.txt'), 'new\n', 'utf-8');
  });

  const after = await readFile(join(outDir, 'marker.txt'), 'utf-8');
  assert.equal(after, 'new\n');
});

test('buildIntoTempThenReplace validates required arguments', async () => {
  await assert.rejects(async () => buildIntoTempThenReplace('', async () => {}), /missing targetDir/i);
  await assert.rejects(async () => buildIntoTempThenReplace('/tmp/out', null), /buildFn must be a function/i);
});
