import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
import { createScmBackendRegistry } from '@/scm/registry';
import { runWithScmAccountScope } from '@/scm/accountScope';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { openSessionHolderWorkspaceChannel, type SessionHolderChild } from '@/subprocess/supervision/sessionHolder';
import { applyManagedWorkspaceReturn, prepareManagedWorkspaceReturnFromStage } from '@/workspaces/sync/managedWorkspaceReturn';
import { runManagedWorkspaceReturnTarget } from '@/workspaces/sync/managedWorkspaceReturnTarget';
import { scanWorkspaceManifest } from '@/scm/workspace/workspaceExportPackaging/scanWorkspaceManifest';

import {
  CONFINED_WORKER_MAX_BODY_BYTES,
  VIRTUAL_SYNC_MAX_REQUEST_LINE_BYTES,
  closeHolderConfinedWorkers,
  createFrameDecoder,
  getHolderConfinedWorkerClient,
} from './confinedWorkerClient';
import { createHolderWorkspaceSource } from './holderWorkspaceSource';
import { workspaceTargetUnavailable } from './workspaceSource';

const holderExecutable = resolveSessionHolderExecutablePath();
const helperExecutable = resolveProcessCustodySupportExecutable('linux');

type LiveHolderHarness = Readonly<{
  holder: SessionHolderChild;
  spawns: Array<readonly string[]>;
  streamProcesses: Array<ReturnType<SessionHolderChild['spawnStream']>>;
  close: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}>;

function startWorkspaceHolder(guestRoot: string, homeDir: string): LiveHolderHarness {
  const proc = spawn(holderExecutable!, ['workspace', '--root', guestRoot], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, HOME: homeDir, PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.once('close', (code, signal) => resolve({ code, signal }));
  });
  const channel = Duplex.from({ readable: proc.stdout, writable: proc.stdin });
  const holder = openSessionHolderWorkspaceChannel(channel);
  const spawns: Array<readonly string[]> = [];
  const streamProcesses: Array<ReturnType<SessionHolderChild['spawnStream']>> = [];
  const originalSpawnStream = holder.spawnStream.bind(holder);
  holder.spawnStream = ((request: Parameters<SessionHolderChild['spawnStream']>[0]) => {
    if ('argv' in request) {
      spawns.push([...request.argv]);
    }
    const stream = originalSpawnStream(request);
    streamProcesses.push(stream);
    return stream;
  }) as SessionHolderChild['spawnStream'];

  return {
    holder,
    spawns,
    streamProcesses,
    close: async () => {
      closeHolderConfinedWorkers(holder);
      holder.detach();
      proc.stdin.end();
      channel.destroy();
      return await exited;
    },
  };
}

describe.skipIf(process.platform !== 'linux' || !holderExecutable || !helperExecutable)('persistent confined guest worker (workspace-confined-serve)', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const dir of cleanupDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('proves 100 stat + 20 readFile + 10 2-phase apply ops spawn exactly 1 Go worker process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rws-rank4-metric-'));
    const guest = await mkdtemp(join(tmpdir(), 'rws-rank4-guest-'));
    cleanupDirs.push(dir, guest);
    const original = join(dir, 'original');
    const staged = join(dir, 'staged');
    await Promise.all([mkdir(original), mkdir(staged)]);

    // Seed 20 files (10 of which will be returned via 2-phase apply).
    for (let i = 0; i < 20; i += 1) {
      const name = `file-${String(i).padStart(2, '0')}.txt`;
      const before = `original-content-${i}\n`;
      const after = i < 10 ? `updated-content-${i}\n` : before;
      await Promise.all([
        writeFile(join(guest, name), before),
        writeFile(join(original, name), before),
        writeFile(join(staged, name), after),
      ]);
    }

    const harness = startWorkspaceHolder(guest, dir);
    try {
      const source = createHolderWorkspaceSource({
        id: 'target:rank4-metric',
        rootPath: original,
        guestRootPath: guest,
        holder: harness.holder,
        helperPath: helperExecutable!,
      });

      // Prepare a 10-file managed return preview before running the timed/counted workload.
      const registry = createScmBackendRegistry([]);
      const baseline = await scanWorkspaceManifest({ workspaceRoot: original, scmRegistry: registry });
      const sessionId = 'rank4-metric-session';
      const accountId = 'rank4-metric-account';
      const workspace = {
        v: 2 as const,
        kind: 'managed' as const,
        serverId: 'home',
        workspaceId: 'original',
        managedId: 'guest',
        rootPath: original,
        controller: { machineId: 'controller', installationId: 'install' },
      };
      const preview = await runWithScmAccountScope(accountId, () => prepareManagedWorkspaceReturnFromStage({
        sessionId, hostRoot: original, stageRoot: staged, activeServerDir: dir, baseline, registry,
        original: { workspace, source },
      }));

      // Reset spawn counter only if preview already warmed the single worker — wait: check total spawns FROM ZERO!
      // Because preview ALSO used the same persistent worker, total spawns across preview + 100 stat + 20 readFile + 10 apply is STILL 1!
      const statResults = await Promise.all(
        Array.from({ length: 100 }, (_, i) => source.stat(join(original, `file-${String(i % 20).padStart(2, '0')}.txt`))),
      );
      expect(statResults).toHaveLength(100);
      expect(statResults[0]!.isFile()).toBe(true);

      const readResults = await Promise.all(
        Array.from({ length: 20 }, (_, i) => source.readFile(join(original, `file-${String(i).padStart(2, '0')}.txt`))),
      );
      for (let i = 0; i < 20; i += 1) {
        expect(readResults[i]!.toString('utf8')).toBe(`original-content-${i}\n`);
      }

      const applyPaths = Array.from({ length: 10 }, (_, i) => `file-${String(i).padStart(2, '0')}.txt`);
      let authorityChecks = 0;
      const applied = await runWithScmAccountScope(accountId, () => applyManagedWorkspaceReturn({
        sessionId,
        returnId: preview.returnId,
        paths: applyPaths,
        activeServerDir: dir,
        withManagedTarget: async (selected, apply) => {
          await runManagedWorkspaceReturnTarget({
            source,
            rootPath: selected.rootPath,
            signal: new AbortController().signal,
            assertCurrentAuthority: async () => { authorityChecks += 1; },
            apply,
          });
        },
      }));
      expect([...applied.appliedPaths].sort()).toEqual(applyPaths);
      expect(applied.conflicts).toEqual([]);
      expect(authorityChecks).toBe(10);

      // Verify all 10 applied files landed on guest disk.
      for (let i = 0; i < 10; i += 1) {
        const name = `file-${String(i).padStart(2, '0')}.txt`;
        await expect(readFile(join(guest, name), 'utf8')).resolves.toBe(`updated-content-${i}\n`);
      }

      // Exercise statBatch & captureBatch on the same persistent worker too.
      const batchPaths = [join(original, 'file-00.txt'), join(original, 'file-19.txt'), join(original, 'missing.txt')];
      const batchStats = await source.statBatch!(batchPaths);
      expect(batchStats.map(item => item.kind)).toEqual(['entry', 'entry', 'missing']);
      const batchCaptures = await source.captureBatch!(batchPaths);
      expect(batchCaptures.map(item => item.kind)).toEqual(['file', 'file', 'missing']);

      // PROVING METRIC: Exactly 1 Go worker process spawned for the entire workload!
      const helperSpawns = harness.spawns.filter(argv => argv[0] === helperExecutable);
      expect(helperSpawns).toEqual([
        [helperExecutable!, 'workspace-confined-serve', '--root', guest],
      ]);
    } finally {
      const exit = await harness.close();
      expect(exit).toEqual({ code: 0, signal: null });
    }
  }, 60_000);

  it('enforces symlink escape, dot-dot traversal, pinned-root rename immunity, and 2-phase authority rejection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rws-rank4-sec-'));
    const guestParent = await mkdtemp(join(tmpdir(), 'rws-rank4-sec-parent-'));
    cleanupDirs.push(dir, guestParent);
    const guest = join(guestParent, 'ws');
    const guestMoved = join(guestParent, 'ws-moved');
    const outsideFile = join(guestParent, 'secret.txt');
    const original = join(dir, 'original');
    const staged = join(dir, 'staged');
    await Promise.all([mkdir(guest), mkdir(original), mkdir(staged)]);
    await Promise.all([
      writeFile(join(guest, 'orig.txt'), 'PINNED-ORIGINAL'),
      writeFile(join(original, 'orig.txt'), 'PINNED-ORIGINAL'),
      writeFile(join(staged, 'orig.txt'), 'REVIEWED-UPDATE'),
      writeFile(outsideFile, 'HOST-SECRET'),
      symlink(outsideFile, join(guest, 'escape')),
    ]);

    const harness = startWorkspaceHolder(guest, dir);
    try {
      const source = createHolderWorkspaceSource({
        id: 'target:rank4-sec',
        rootPath: original,
        guestRootPath: guest,
        holder: harness.holder,
        helperPath: helperExecutable!,
      });

      // 1. Prime the persistent worker and verify symlink + .. escapes are blocked.
      await expect(source.readFile(join(original, 'orig.txt'))).resolves.toEqual(Buffer.from('PINNED-ORIGINAL'));
      await expect(source.stat(join(original, 'escape'))).rejects.toMatchObject({ code: 'workspace_root_unsafe' });
      await expect(source.readFile(join(original, 'escape'))).rejects.toMatchObject({ code: 'workspace_root_unsafe' });
      await expect(source.readFile(join(original, '..', 'secret.txt'))).rejects.toMatchObject({ code: 'workspace_root_unsafe' });
      await expect(source.writeFile(join(original, '..', 'pwn.txt'), Buffer.from('x'))).rejects.toMatchObject({ code: 'workspace_root_unsafe' });

      // 2. 2-phase authority rejection leaves target untouched even after prepare.
      const registry = createScmBackendRegistry([]);
      const baseline = await scanWorkspaceManifest({ workspaceRoot: original, scmRegistry: registry });
      const workspace = {
        v: 2 as const, kind: 'managed' as const, serverId: 'home', workspaceId: 'original',
        managedId: 'guest', rootPath: original, controller: { machineId: 'controller', installationId: 'install' },
      };
      const preview = await runWithScmAccountScope('sec-acct', () => prepareManagedWorkspaceReturnFromStage({
        sessionId: 'sec-session', hostRoot: original, stageRoot: staged, activeServerDir: dir, baseline, registry,
        original: { workspace, source },
      }));
      await expect(runWithScmAccountScope('sec-acct', () => applyManagedWorkspaceReturn({
        sessionId: 'sec-session', returnId: preview.returnId, paths: ['orig.txt'], activeServerDir: dir,
        withManagedTarget: async (selected, apply) => {
          await runManagedWorkspaceReturnTarget({
            source, rootPath: selected.rootPath, signal: new AbortController().signal,
            assertCurrentAuthority: async () => { throw workspaceTargetUnavailable(); },
            apply,
          });
        },
      }))).rejects.toMatchObject({ code: 'workspace_target_unavailable' });
      await expect(readFile(join(guest, 'orig.txt'), 'utf8')).resolves.toBe('PINNED-ORIGINAL');

      // 3. Rename the guest root on disk after startup and replace with a decoy directory.
      await rename(guest, guestMoved);
      await mkdir(guest);
      await writeFile(join(guest, 'orig.txt'), 'ATTACKER-DECOY');
      await writeFile(join(guest, 'decoy.txt'), 'DECOY-ONLY');

      // Worker remains strictly pinned to the original dirfd (now at guestMoved).
      await expect(source.readFile(join(original, 'orig.txt'))).resolves.toEqual(Buffer.from('PINNED-ORIGINAL'));
      await expect(source.stat(join(original, 'decoy.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await source.writeFile(join(original, 'pinned-write.txt'), Buffer.from('STILL-PINNED'));
      await expect(readFile(join(guestMoved, 'pinned-write.txt'), 'utf8')).resolves.toBe('STILL-PINNED');
      await expect(readFile(join(guest, 'pinned-write.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      // Still only 1 Go worker spawned throughout!
      expect(harness.spawns.filter(argv => argv[0] === helperExecutable)).toHaveLength(1);
    } finally {
      const exit = await harness.close();
      expect(exit).toEqual({ code: 0, signal: null });
    }
  }, 60_000);

  it('falls back transparently to one-shot subcommands when guest binary lacks workspace-confined-serve', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rws-rank4-legacy-'));
    const guest = await mkdtemp(join(tmpdir(), 'rws-rank4-legacy-guest-'));
    cleanupDirs.push(dir, guest);
    await writeFile(join(guest, 'hello.txt'), 'legacy-ok');

    // Wrapper simulating an older guest binary that exits 2 (usage) on workspace-confined-serve.
    const shimPath = join(dir, 'legacy-custody-helper.sh');
    await writeFile(shimPath, [
      '#!/bin/sh',
      'if [ "$1" = "workspace-confined-serve" ]; then',
      '  echo "usage: legacy helper" >&2',
      '  exit 2',
      'fi',
      `exec "${helperExecutable!}" "$@"`,
      '',
    ].join('\n'));
    await chmod(shimPath, 0o755);

    const harness = startWorkspaceHolder(guest, dir);
    try {
      const source = createHolderWorkspaceSource({
        id: 'target:rank4-legacy',
        rootPath: guest,
        holder: harness.holder,
        helperPath: shimPath,
      });

      await expect(source.stat(join(guest, 'hello.txt'))).resolves.toMatchObject({ size: 9 });
      await expect(source.readFile(join(guest, 'hello.txt'))).resolves.toEqual(Buffer.from('legacy-ok'));
      await source.writeFile(join(guest, 'new.txt'), Buffer.from('written-legacy'));
      await expect(source.readFile(join(guest, 'new.txt'))).resolves.toEqual(Buffer.from('written-legacy'));
      await expect(source.captureLeaf!(join(guest, 'new.txt'))).resolves.toMatchObject({ kind: 'file' });
      await source.rm(join(guest, 'new.txt'));
      await expect(source.lstat(join(guest, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

      // workspace-confined-serve was tried ONCE, then sticky fallback routed subsequent ops to one-shot commands.
      const serveAttempts = harness.spawns.filter(argv => argv[1] === 'workspace-confined-serve');
      expect(serveAttempts).toHaveLength(1);
      expect(harness.spawns.some(argv => argv[1] === 'workspace-confined-meta')).toBe(true);
      expect(harness.spawns.some(argv => argv[1] === 'workspace-confined-write')).toBe(true);
    } finally {
      const exit = await harness.close();
      expect(exit).toEqual({ code: 0, signal: null });
    }
  }, 60_000);

  it('handles per-request cancellation cleanly and auto-restarts safely after unexpected worker crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rws-rank4-crash-'));
    const guest = await mkdtemp(join(tmpdir(), 'rws-rank4-crash-guest-'));
    cleanupDirs.push(dir, guest);
    await writeFile(join(guest, 'a.txt'), 'alive');

    const harness = startWorkspaceHolder(guest, dir);
    try {
      const source = createHolderWorkspaceSource({
        id: 'target:rank4-crash',
        rootPath: guest,
        holder: harness.holder,
        helperPath: helperExecutable!,
      });

      // 1. Warm the persistent worker.
      await expect(source.readFile(join(guest, 'a.txt'))).resolves.toEqual(Buffer.from('alive'));
      expect(harness.spawns).toHaveLength(1);

      // 2. Per-request cancellation via AbortSignal rejects cleanly without killing the worker.
      const client = getHolderConfinedWorkerClient(harness.holder, helperExecutable!, guest);
      const aborted = new AbortController();
      aborted.abort(new Error('caller-cancelled'));
      await expect(client.meta('stat', 'a.txt', { signal: aborted.signal })).rejects.toThrow('caller-cancelled');
      // Worker is still alive and serves subsequent requests without respawning.
      await expect(source.stat(join(guest, 'a.txt'))).resolves.toMatchObject({ size: 5 });
      expect(harness.spawns).toHaveLength(1);

      // 3. Unexpected worker crash (SIGKILL) -> next request safely respawns a fresh worker.
      const firstWorkerStream = harness.streamProcesses[0]!;
      const crashed = new Promise<void>(resolve => firstWorkerStream.once('close', () => resolve()));
      firstWorkerStream.kill('SIGKILL');
      await crashed;

      await expect(source.readFile(join(guest, 'a.txt'))).resolves.toEqual(Buffer.from('alive'));
      expect(harness.spawns).toHaveLength(2);
      expect(harness.spawns[1]).toEqual([helperExecutable!, 'workspace-confined-serve', '--root', guest]);
    } finally {
      const exit = await harness.close();
      expect(exit).toEqual({ code: 0, signal: null });
    }
  }, 60_000);

  it('aborts and closes cleanly on stdin EOF without a decision line in VirtualConfinedSyncProcess (no hang or leaked pending op)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rws-rank4-eof-'));
    const guest = await mkdtemp(join(tmpdir(), 'rws-rank4-eof-guest-'));
    cleanupDirs.push(dir, guest);
    const initial = 'initial-eof-content\n';
    await writeFile(join(guest, 'target.txt'), initial);

    const harness = startWorkspaceHolder(guest, dir);
    try {
      const source = createHolderWorkspaceSource({
        id: 'target:rank4-eof',
        rootPath: guest,
        holder: harness.holder,
        helperPath: helperExecutable!,
      });

      // Advisory #1: prototype property names must never match command map.
      const client = getHolderConfinedWorkerClient(harness.holder, helperExecutable!, guest);
      expect(client.spawnVirtualConfinedSyncCommand(['constructor'], () => {
        throw new Error('should not be called');
      })).toBeNull();

      // Warm the worker first.
      await expect(source.stat(join(guest, 'target.txt'))).resolves.toMatchObject({ size: initial.length });
      const expected = await source.observeSyncEntry!(join(guest, 'target.txt'));

      // Case A: 2-phase delete reaches prepared, then caller closes stdin WITHOUT sending commit/abort.
      const childA = source.spawn({ command: helperExecutable!, args: ['workspace-confined-delete'] });
      const preparedA = new Promise<string>((resolve, reject) => {
        let out = '';
        childA.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8');
          if (out.includes('\n')) resolve(out.trim());
        });
        childA.once('error', reject);
      });
      const closedA = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('VirtualConfinedSyncProcess hung after stdin EOF')), 3000);
        childA.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      childA.stdin.write(`${JSON.stringify({
        v: 1,
        rootPath: guest,
        relativePath: 'target.txt',
        expectedKind: expected.kind,
        expectedDigest: expected.kind === 'file' ? expected.digest : undefined,
      })}\n`);
      const prepLine = await preparedA;
      expect(JSON.parse(prepLine)).toEqual({ v: 1, t: 'workspace-confined-prepared' });
      // Close stdin without sending a decision line!
      childA.stdin.end();
      const codeA = await closedA;
      expect(codeA).toBe(1);
      // File must NOT have been deleted, and worker must still be healthy (still 1 spawn!).
      await expect(readFile(join(guest, 'target.txt'), 'utf8')).resolves.toBe(initial);
      await expect(source.stat(join(guest, 'target.txt'))).resolves.toMatchObject({ size: initial.length });
      expect(harness.spawns).toHaveLength(1);

      // Case B: stdin closes with an incomplete first request line (no newline) -> fails closed without hanging.
      const childB = source.spawn({ command: helperExecutable!, args: ['workspace-confined-delete'] });
      const closedB = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('VirtualConfinedSyncProcess hung on incomplete header EOF')), 3000);
        childB.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      childB.stdin.end('{"v":1,"partial":true');
      expect(await closedB).toBe(1);

      // Case C: stdin closes immediately after request line (racing before prepared arrives).
      const childC = source.spawn({ command: helperExecutable!, args: ['workspace-confined-delete'] });
      const closedC = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('VirtualConfinedSyncProcess hung on early EOF before prepared')), 3000);
        childC.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      childC.stdin.end(`${JSON.stringify({
        v: 1,
        rootPath: guest,
        relativePath: 'target.txt',
        expectedKind: expected.kind,
        expectedDigest: expected.kind === 'file' ? expected.digest : undefined,
      })}\n`);
      expect(await closedC).toBe(1);
      await expect(readFile(join(guest, 'target.txt'), 'utf8')).resolves.toBe(initial);
      expect(harness.spawns).toHaveLength(1);

      // Case D: streaming 2-phase apply with stageOnTarget:true reaches prepared, then stdin closes without decision:
      // worker must abort, remove guest staging directory, and emit close without hanging.
      const stagingRoot = join(dir, '.happier', 'workspace-sync');
      const { create: createTar } = await import('tar');
      const stageDir = await mkdtemp(join(tmpdir(), 'rws-rank4-eof-stage-'));
      cleanupDirs.push(stageDir);
      const nextContent = 'staged-content-should-abort\n';
      await writeFile(join(stageDir, 'target.txt'), nextContent);
      const { createHash } = await import('node:crypto');
      const nextDigest = createHash('sha1').update(nextContent).digest('hex');

      const childD = source.spawn({ command: helperExecutable!, args: ['workspace-confined-apply'] });
      const preparedD = new Promise<string>((resolve, reject) => {
        let out = '';
        childD.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8');
          if (out.includes('\n')) resolve(out.trim());
        });
        childD.once('error', reject);
      });
      const closedD = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('VirtualConfinedSyncProcess hung on streaming apply EOF')), 3000);
        childD.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      childD.stdin.write(`${JSON.stringify({
        v: 1,
        rootPath: guest,
        relativePath: 'target.txt',
        expectedDestination: expected,
        selectedExpectation: { kind: 'file', digest: nextDigest, executable: false, size: nextContent.length },
        stageOnTarget: true,
        materialPath: 'target.txt',
        operationId: 'op-eof-stage',
      })}\n`);
      for await (const chunk of createTar({ cwd: stageDir, portable: true }, ['./target.txt'])) {
        childD.stdin.write(chunk);
      }
      expect(JSON.parse(await preparedD)).toEqual({ v: 1, t: 'workspace-confined-prepared' });
      // Close stdin without sending commit/abort!
      childD.stdin.end();
      expect(await closedD).toBe(1);
      await expect(readFile(join(guest, 'target.txt'), 'utf8')).resolves.toBe(initial);
      const remainingStages = await readdir(stagingRoot).catch(() => []);
      expect(remainingStages).toEqual([]);
      expect(harness.spawns).toHaveLength(1);
    } finally {
      const exit = await harness.close();
      expect(exit).toEqual({ code: 0, signal: null });
    }
  }, 60_000);

  it('enforces frame decoder header/body bounds, O(N) chunked binary bodies, and VirtualConfinedSyncProcess header limits + non-object rejection', async () => {
    // 1. Frame decoder: newline-free oversized header rejected immediately.
    const errors1: Error[] = [];
    const decode1 = createFrameDecoder(() => undefined, (err) => errors1.push(err), { maxHeaderBytes: 64, maxBodyBytes: 128 });
    decode1(Buffer.from('{"v":1,"pad":"' + 'a'.repeat(40)));
    expect(errors1).toHaveLength(0);
    decode1(Buffer.from('b'.repeat(40)));
    expect(errors1).toHaveLength(1);
    expect(errors1[0]!.message).toContain('header line exceeds limit');

    // 2. Frame decoder: newline-terminated oversized header rejected.
    const errors2: Error[] = [];
    const decode2 = createFrameDecoder(() => undefined, (err) => errors2.push(err), { maxHeaderBytes: 32, maxBodyBytes: 128 });
    decode2(Buffer.from('{"v":1,"x":"' + 'z'.repeat(40) + '"}\n'));
    expect(errors2).toHaveLength(1);
    expect(errors2[0]!.message).toContain('header line exceeds limit');

    // 3. Frame decoder: aligned 128 MiB body limit rejects > CONFINED_WORKER_MAX_BODY_BYTES.
    expect(CONFINED_WORKER_MAX_BODY_BYTES).toBe(128 * 1024 * 1024);
    const errors3: Error[] = [];
    const decode3 = createFrameDecoder(() => undefined, (err) => errors3.push(err));
    decode3(Buffer.from(`${JSON.stringify({ v: 1, id: '1', t: 'result', bodyBytes: CONFINED_WORKER_MAX_BODY_BYTES + 1 })}\n`));
    expect(errors3).toHaveLength(1);
    expect(errors3[0]!.message).toContain('invalid bodyBytes');

    // 4. Frame decoder: multi-chunk binary body + pipelined header decoded cleanly.
    const frames: Array<{ id?: string; body: Buffer }> = [];
    const errors4: Error[] = [];
    const decode4 = createFrameDecoder((h, b) => frames.push({ id: h.id, body: b }), (err) => errors4.push(err));
    const binaryPayload = Buffer.from([0x00, 0x01, 0x0a, 0xff, 0xfe, 0x42, 0x43, 0x44]);
    const wire = Buffer.concat([
      Buffer.from(`${JSON.stringify({ v: 1, id: 'b1', t: 'result', bodyBytes: binaryPayload.byteLength })}\n`),
      binaryPayload,
      Buffer.from(`${JSON.stringify({ v: 1, id: 'b2', t: 'result' })}\n`),
    ]);
    for (let i = 0; i < wire.byteLength; i += 3) {
      decode4(wire.subarray(i, Math.min(i + 3, wire.byteLength)));
    }
    expect(errors4).toEqual([]);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.id).toBe('b1');
    expect(frames[0]!.body).toEqual(binaryPayload);
    expect(frames[1]!.id).toBe('b2');
    expect(frames[1]!.body.byteLength).toBe(0);

    // 5. VirtualConfinedSyncProcess: rejects oversized request header (> 64 KiB) and non-object JSON fail-closed.
    const dir = await mkdtemp(join(tmpdir(), 'rws-rank4-bounds-'));
    const guest = await mkdtemp(join(tmpdir(), 'rws-rank4-bounds-guest-'));
    cleanupDirs.push(dir, guest);
    const harness = startWorkspaceHolder(guest, dir);
    try {
      const source = createHolderWorkspaceSource({
        id: 'target:rank4-bounds',
        rootPath: guest,
        holder: harness.holder,
        helperPath: helperExecutable!,
      });

      const bigChild = source.spawn({ command: helperExecutable!, args: ['workspace-confined-delete'] });
      const bigClosed = new Promise<number | null>(resolve => bigChild.once('close', code => resolve(code)));
      bigChild.stdin.write(Buffer.alloc(VIRTUAL_SYNC_MAX_REQUEST_LINE_BYTES + 128, 0x61));
      bigChild.stdin.end();
      expect(await bigClosed).toBe(1);

      const nullChild = source.spawn({ command: helperExecutable!, args: ['workspace-confined-delete'] });
      const nullClosed = new Promise<number | null>(resolve => nullChild.once('close', code => resolve(code)));
      nullChild.stdin.end('null\n');
      expect(await nullClosed).toBe(1);

      const arrChild = source.spawn({ command: helperExecutable!, args: ['workspace-confined-delete'] });
      const arrClosed = new Promise<number | null>(resolve => arrChild.once('close', code => resolve(code)));
      arrChild.stdin.end('[1,2,3]\n');
      expect(await arrClosed).toBe(1);
    } finally {
      const exit = await harness.close();
      expect(exit).toEqual({ code: 0, signal: null });
    }
  }, 60_000);

  it('propagates worker stdin drain backpressure in VirtualConfinedSyncProcess without hanging on close', async () => {
    const fakeHolder = Object.assign(new EventEmitter(), {
      holderConnectionFailed: false,
      spawnStream: () => fakeStream,
    }) as unknown as SessionHolderChild;

    let releaseDrain: (() => void) | null = null;
    let applyChunkCount = 0;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({
      highWaterMark: 16,
      write(chunk: Buffer, _enc, cb) {
        const text = chunk.toString('utf8');
        if (text.includes('"op":"apply-chunk"')) {
          applyChunkCount += 1;
          // Hold backpressure until the test explicitly releases it.
          releaseDrain = cb;
          return;
        }
        cb();
      },
    });
    const fakeStream = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: () => true,
      terminateTree: async () => undefined,
    });

    const client = getHolderConfinedWorkerClient(fakeHolder, '/fake/helper', '/fake/guest');
    const child = client.spawnVirtualConfinedSyncCommand(['workspace-confined-apply'], () => {
      throw new Error('fallback should not be called');
    })!;
    expect(child).not.toBeNull();

    // Emit ready frame from fake worker after request kicks off startup.
    queueMicrotask(() => {
      stdout.write(`${JSON.stringify({ v: 1, t: 'workspace-confined-serve-ready' })}\n`);
    });

    child.stdin.write(`${JSON.stringify({
      v: 1,
      rootPath: '/fake/guest',
      relativePath: 'a.txt',
      stageOnTarget: true,
      materialPath: 'a.txt',
      operationId: 'op-bp',
    })}\n`);

    // Allow worker ready + phase transition to 'staging'.
    await new Promise(resolve => setTimeout(resolve, 20));

    let writeCallbackFired = false;
    child.stdin.write(Buffer.alloc(1024, 0x58), () => {
      writeCallbackFired = true;
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(applyChunkCount).toBe(1);
    // Downstream stdin has not drained yet, so VirtualConfinedSyncProcess._write must NOT have invoked callback.
    expect(writeCallbackFired).toBe(false);

    // Release downstream stdin write -> drain fires -> VirtualConfinedSyncProcess._write callback resolves.
    releaseDrain!();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(writeCallbackFired).toBe(true);

    // Now simulate stream closing while backpressured: callback must still settle cleanly (never hang).
    let secondCallbackFired = false;
    child.stdin.write(Buffer.alloc(1024, 0x59), () => {
      secondCallbackFired = true;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(secondCallbackFired).toBe(false);
    fakeStream.emit('close', 1, null);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(secondCallbackFired).toBe(true);
    closeHolderConfinedWorkers(fakeHolder);
  });
});
