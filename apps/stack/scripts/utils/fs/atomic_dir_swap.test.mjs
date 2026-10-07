import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';

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

test('mounted publication replaces workspace links without changing their producer, and restores links on failure', async (t) => {
  for (const fail of [false, true]) await t.test(fail ? 'rollback' : 'success', async (t) => {
    const root = await withTempRoot(t);
    const producer = join(root, 'producer');
    const outDir = join(root, 'consumer');
    await mkdir(producer);
    await writeFile(join(producer, 'package.json'), '{"scripts":{"build":"authored"}}\n');
    await symlink(producer, outDir, process.platform === 'win32' ? 'junction' : 'dir');
    // The mounted publisher accepts filesystem adapters directly; exercise its
    // rollback at that real boundary rather than substituting its logic.
    if (fail) {
      const { publishStagedDirectoryMountedSync } = await import('@happier-dev/cli-common/workspaceRuntimeDependencies');
      const stage = join(root, 'stage');
      await mkdir(stage);
      await writeFile(join(stage, 'index.js'), 'new\n');
      await writeFile(join(stage, 'package.json'), '{"private":true}\n');
      const fs = await import('node:fs');
      assert.throws(() => publishStagedDirectoryMountedSync({ stagedDir: stage, liveDir: outDir,
        rollbackDir: join(root, 'rollback'), fsOps: { renameSync(from, to) {
          if (from === join(stage, 'package.json')) throw new Error('publication failure');
          fs.renameSync(from, to);
        } } }), /publication failure/);
      assert.equal((await lstat(outDir)).isSymbolicLink(), true);
    } else {
      await buildIntoTempThenReplace(outDir, async (tmp) => {
        await writeFile(join(tmp, 'index.js'), 'export const value = 1;\n');
        await writeFile(join(tmp, 'package.json'), '{"private":true}\n');
      }, { preserveDestinationPath: true });
      assert.equal((await lstat(outDir)).isDirectory(), true);
      assert.equal(await readFile(join(outDir, 'package.json'), 'utf8'), '{"private":true}\n');
    }
    assert.equal(await readFile(join(producer, 'package.json'), 'utf8'), '{"scripts":{"build":"authored"}}\n');
    assert.deepEqual(await readdir(producer), ['package.json']);
  });
});

test('buildIntoTempThenReplace removes its stage after either promotion rename fails', async (t) => {
  for (const failure of ['backup', 'promotion']) await t.test(failure, async (t) => {
    const root = await withTempRoot(t);
    const outDir = join(root, 'dist');
    await mkdir(outDir);
    await writeFile(join(outDir, 'marker.txt'), 'old\n');
    await assert.rejects(buildIntoTempThenReplace(outDir, async (tmp) => {
      await writeFile(join(tmp, 'marker.txt'), 'new\n');
    }, { renameImpl: async (from, to) => {
      if ((failure === 'backup' && from === outDir) || (failure === 'promotion' && from.includes('.tmp.'))) {
        throw new Error(`${failure} failure`);
      }
      await rename(from, to);
    } }), new RegExp(`${failure} failure`));
    assert.equal(await readFile(join(outDir, 'marker.txt'), 'utf8'), 'old\n');
    assert.deepEqual(await readdir(root), ['dist'], 'publisher-owned stages cannot outlive failed promotion');
  });
});

test('mounted publication keeps the canonical recovery backup when rollback fails', async (t) => {
  const root = await withTempRoot(t);
  const outDir = join(root, 'dist');
  await mkdir(outDir);
  await writeFile(join(outDir, 'index.js'), 'old\n');
  await writeFile(join(outDir, 'package.json'), '{"old":true}\n');
  const nativeRename = fs.renameSync;
  // Mounted publication imports the synchronous OS adapter. Patch only this
  // fixture's rename failures, keeping publication and rollback logic real.
  fs.renameSync = (from, to) => {
    if (String(from).includes('.tmp.') && String(from).endsWith('package.json')) throw new Error('publication blocked');
    if (String(from).includes('.backup.') && to === join(outDir, 'index.js')) throw new Error('restore blocked');
    return nativeRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(buildIntoTempThenReplace(outDir, async (tmp) => {
      await writeFile(join(tmp, 'index.js'), 'new\n');
      await writeFile(join(tmp, 'package.json'), '{"new":true}\n');
    }, { preserveDestinationPath: true }), AggregateError);
  } finally {
    fs.renameSync = nativeRename;
    syncBuiltinESMExports();
  }
  const backups = (await readdir(root)).filter(name => name.startsWith('.backup.'));
  assert.equal(backups.length, 1, 'only the canonical rollback owner can retire a failed recovery backup');
  const savedFiles = await readdir(join(root, backups[0]));
  const savedContents = await Promise.all(savedFiles.map(name => readFile(join(root, backups[0], name), 'utf8')));
  assert.ok(savedContents.includes('old\n'), 'the displaced output remains recoverable after failed restoration');
  assert.equal((await readdir(root)).some(name => name.startsWith('.tmp.')), false);
});

test('buildIntoTempThenReplace validates required arguments', async () => {
  await assert.rejects(async () => buildIntoTempThenReplace('', async () => {}), /missing targetDir/i);
  await assert.rejects(async () => buildIntoTempThenReplace('/tmp/out', null), /buildFn must be a function/i);
});
