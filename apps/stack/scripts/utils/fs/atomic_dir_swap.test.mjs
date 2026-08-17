import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

test('buildIntoTempThenReplace leaves the live dir in place when staged build fails', async (t) => {
  const root = await withTempRoot(t);
  const outDir = join(root, 'ui');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'marker.txt'), 'old\n', 'utf-8');
  const before = await stat(outDir);

  await assert.rejects(
    async () => {
      await buildIntoTempThenReplace(outDir, async (tmp) => {
        await writeFile(join(tmp, 'marker.txt'), 'new\n', 'utf-8');
        throw new Error('boom');
      });
    },
    /boom/
  );

  const after = await stat(outDir);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(await readFile(join(outDir, 'marker.txt'), 'utf-8'), 'old\n');
});

test('buildIntoTempThenReplace never republishes a stale pre-build snapshot after failure', async (t) => {
  const root = await withTempRoot(t);
  const outDir = join(root, 'ui');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'marker.txt'), 'old\n', 'utf-8');

  await assert.rejects(
    async () => {
      await buildIntoTempThenReplace(outDir, async (tmp) => {
        await writeFile(join(tmp, 'marker.txt'), 'new\n', 'utf-8');
        await rm(outDir, { recursive: true, force: true });
        throw new Error('boom');
      });
    },
    /boom/
  );

  await assert.rejects(
    () => readFile(join(outDir, 'marker.txt'), 'utf-8'),
    /ENOENT/,
  );
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

test('buildIntoTempThenReplace keeps a live resolver tree mounted and retains prior targets', async (t) => {
  const root = await withTempRoot(t);
  const outDir = join(root, 'ui');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'entry.mjs'), 'export const generation = "old";\n', 'utf-8');
  await writeFile(join(outDir, 'old.chunk.bundle'), 'old chunk\n', 'utf-8');
  const before = await stat(outDir);

  await buildIntoTempThenReplace(
    outDir,
    async (tmp) => {
      await writeFile(join(tmp, 'entry.mjs'), 'export const generation = "new";\n', 'utf-8');
      await writeFile(join(tmp, 'new.chunk.bundle'), 'new chunk\n', 'utf-8');
    },
    {
      preserveDestinationPath: true,
      pruneStale: false,
    },
  );

  const after = await stat(outDir);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(await readFile(join(outDir, 'entry.mjs'), 'utf-8'), 'export const generation = "new";\n');
  assert.equal(await readFile(join(outDir, 'new.chunk.bundle'), 'utf-8'), 'new chunk\n');
  assert.equal(
    await readFile(join(outDir, 'old.chunk.bundle'), 'utf-8'),
    'old chunk\n',
    'an in-flight Metro graph must retain the prior content-addressed target',
  );
});

test('buildIntoTempThenReplace retries transient Windows rename locks', async (t) => {
  const root = await withTempRoot(t);
  const outDir = join(root, 'ui');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'marker.txt'), 'old\n', 'utf-8');

  let stagedRenameAttempts = 0;
  const waits = [];
  await buildIntoTempThenReplace(
    outDir,
    async (tmp) => {
      await writeFile(join(tmp, 'marker.txt'), 'new\n', 'utf-8');
    },
    {
      platform: 'win32',
      async renameImpl(from, to) {
        if (from.includes('.tmp.')) {
          stagedRenameAttempts += 1;
          if (stagedRenameAttempts < 3) {
            const error = new Error('temporarily locked');
            error.code = 'EBUSY';
            throw error;
          }
        }
        await import('node:fs/promises').then((fs) => fs.rename(from, to));
      },
      async waitImpl(ms) {
        waits.push(ms);
      },
    },
  );

  assert.equal(stagedRenameAttempts, 3);
  assert.deepEqual(waits, [25, 50]);
  assert.equal(await readFile(join(outDir, 'marker.txt'), 'utf-8'), 'new\n');
});

test('buildIntoTempThenReplace validates required arguments', async () => {
  await assert.rejects(async () => buildIntoTempThenReplace('', async () => {}), /missing targetDir/i);
  await assert.rejects(async () => buildIntoTempThenReplace('/tmp/out', null), /buildFn must be a function/i);
});
