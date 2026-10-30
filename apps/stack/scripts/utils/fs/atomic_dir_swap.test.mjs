import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { readProcessHostIdentitySync, readProcessInstanceFingerprintSync } from '../../../../../packages/cli-common/processInstance.mjs';

import { buildIntoTempThenReplace } from './atomic_dir_swap.mjs';

async function withTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-atomic-dir-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function startPausedWriter(t, outDir) {
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { buildIntoTempThenReplace } from ${JSON.stringify(new URL('./atomic_dir_swap.mjs', import.meta.url).href)};
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    await buildIntoTempThenReplace(process.argv[1], async (staged) => {
      process.send(staged);
      await new Promise(resolve => process.on('message', resolve));
      await writeFile(join(staged, 'marker.txt'), 'child');
    });
    process.disconnect();
  `, outDir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (writer.exitCode !== null || writer.signalCode !== null) return;
    const exited = once(writer, 'exit');
    writer.kill('SIGKILL');
    await exited;
  });
  const [staged] = await once(writer, 'message');
  return { writer, staged };
}

test('the next build reclaims staging left by a killed writer', async (t) => {
  const root = await withTempRoot(t);
  const outDir = join(root, 'dist');
  const { writer, staged: abandoned } = await startPausedWriter(t, outDir);
  const exited = once(writer, 'exit');
  writer.kill('SIGKILL');
  await exited;
  // Pre-fix writers have no birth record; a dead PID still proves abandonment.
  const legacy = join(root, `.tmp.1.${writer.pid}.abc`);
  await mkdir(legacy);

  await buildIntoTempThenReplace(outDir, async staged => {
    await writeFile(join(staged, 'marker.txt'), 'published');
  });

  await assert.rejects(stat(abandoned), { code: 'ENOENT' });
  await assert.rejects(stat(`${abandoned}.owner.json`), { code: 'ENOENT' });
  await assert.rejects(stat(legacy), { code: 'ENOENT' });
  assert.equal(await readFile(join(outDir, 'marker.txt'), 'utf8'), 'published');
});

test('a concurrent build preserves the live writer and unrelated siblings', async (t) => {
  const root = await withTempRoot(t);
  const legacyLive = join(root, `.tmp.1.${process.pid}.abc`);
  const unrelated = join(root, '.tmp.unrecognized');
  const symlinkPath = join(root, '.tmp.1.2147483647.abc');
  await mkdir(legacyLive);
  await mkdir(unrelated);
  if (process.platform !== 'win32') await symlink(unrelated, symlinkPath, 'dir');
  const { writer, staged: concurrent } = await startPausedWriter(t, join(root, 'child'));

  await buildIntoTempThenReplace(join(root, 'first'), async first => {
    await buildIntoTempThenReplace(join(root, 'second'), async staged => {
      await writeFile(join(staged, 'marker.txt'), 'second');
    });
    assert.equal((await stat(first)).isDirectory(), true);
    await writeFile(join(first, 'marker.txt'), 'first');
  });

  assert.equal((await stat(legacyLive)).isDirectory(), true);
  assert.equal((await stat(unrelated)).isDirectory(), true);
  assert.equal((await stat(concurrent)).isDirectory(), true);
  if (process.platform !== 'win32') assert.equal((await lstat(symlinkPath)).isSymbolicLink(), true);
  assert.equal(await readFile(join(root, 'first', 'marker.txt'), 'utf8'), 'first');
  assert.equal(await readFile(join(root, 'second', 'marker.txt'), 'utf8'), 'second');
  const exited = once(writer, 'exit');
  writer.send('finish');
  const [exitCode] = await exited;
  assert.equal(exitCode, 0);
  assert.equal(await readFile(join(root, 'child', 'marker.txt'), 'utf8'), 'child');
});

test('a reused PID is reclaimable only with a local mismatching birth witness', async (t) => {
  const root = await withTempRoot(t);
  const host = readProcessHostIdentitySync();
  const fingerprint = readProcessInstanceFingerprintSync(process.pid);
  if (!host || !fingerprint) return t.skip('process identity unavailable');
  const reused = join(root, `.tmp.1.${process.pid}.abc`);
  const foreign = join(root, `.tmp.2.${process.pid}.abc`);
  const unknown = join(root, `.tmp.3.${process.pid}.abc`);
  for (const directory of [reused, foreign, unknown]) await mkdir(directory);
  const owner = { v: 1, pid: process.pid, processInstanceFingerprint: `${fingerprint}:previous`, host };
  await writeFile(`${reused}.owner.json`, JSON.stringify(owner));
  await writeFile(`${foreign}.owner.json`, JSON.stringify({ ...owner, host: { ...host, machineId: 'another-host' } }));
  await writeFile(`${unknown}.owner.json`, '{}');

  await buildIntoTempThenReplace(join(root, 'dist'), async staged => {
    await writeFile(join(staged, 'marker.txt'), 'published');
  });

  await assert.rejects(stat(reused), { code: 'ENOENT' });
  assert.equal((await stat(foreign)).isDirectory(), true);
  assert.equal((await stat(unknown)).isDirectory(), true);
  assert.deepEqual(await readdir(join(root, 'dist')), ['marker.txt']);
});

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
  for (const linkState of ['live', 'dangling', 'nested-dangling']) for (const fail of [false, true]) await t.test(`${linkState} link ${fail ? 'rollback' : 'success'}`, async (t) => {
    const root = await withTempRoot(t);
    const producer = join(root, 'producer');
    const outDir = join(root, 'consumer');
    const nested = linkState === 'nested-dangling';
    const targetExists = linkState === 'live';
    const packageDir = nested ? join(outDir, 'package') : outDir;
    await mkdir(producer);
    await writeFile(join(producer, 'package.json'), '{"scripts":{"build":"authored"}}\n');
    if (nested) await mkdir(outDir);
    const linkTarget = process.platform === 'win32' ? producer : relative(dirname(packageDir), producer);
    await symlink(linkTarget, packageDir, process.platform === 'win32' ? 'junction' : 'dir');
    const originalLink = await readlink(packageDir);
    if (!targetExists) await rm(producer, { recursive: true });
    // The mounted publisher accepts filesystem adapters directly; exercise its
    // rollback at that real boundary rather than substituting its logic.
    if (fail) {
      const { publishStagedDirectoryMountedSync } = await import('@happier-dev/cli-common/workspaceRuntimeDependencies');
      const stage = join(root, 'stage');
      const stagedPackage = nested ? join(stage, 'package') : stage;
      await mkdir(stagedPackage, { recursive: true });
      await writeFile(join(stagedPackage, 'index.js'), 'new\n');
      await writeFile(join(stagedPackage, 'package.json'), '{"private":true}\n');
      const fs = await import('node:fs');
      assert.throws(() => publishStagedDirectoryMountedSync({ stagedDir: stage, liveDir: outDir,
        rollbackDir: join(root, 'rollback'), fsOps: { renameSync(from, to) {
          if (from === join(stage, 'package.json') || (nested && from === stagedPackage)) throw new Error('publication failure');
          fs.renameSync(from, to);
        } } }), /publication failure/);
      assert.equal((await lstat(packageDir)).isSymbolicLink(), true);
      assert.equal(await readlink(packageDir), originalLink);
    } else {
      await buildIntoTempThenReplace(outDir, async (tmp) => {
        const stagedPackage = nested ? join(tmp, 'package') : tmp;
        await mkdir(stagedPackage, { recursive: true });
        await writeFile(join(stagedPackage, 'index.js'), 'export const value = 1;\n');
        await writeFile(join(stagedPackage, 'package.json'), '{"private":true}\n');
      }, { preserveDestinationPath: true });
      assert.equal((await lstat(packageDir)).isDirectory(), true);
      assert.equal(await readFile(join(packageDir, 'package.json'), 'utf8'), '{"private":true}\n');
    }
    if (targetExists) {
      assert.equal(await readFile(join(producer, 'package.json'), 'utf8'), '{"scripts":{"build":"authored"}}\n');
      assert.deepEqual(await readdir(producer), ['package.json']);
    } else {
      await assert.rejects(lstat(producer), { code: 'ENOENT' });
    }
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
