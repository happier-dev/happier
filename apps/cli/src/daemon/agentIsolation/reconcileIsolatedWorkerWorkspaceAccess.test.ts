import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, watch } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIsolatedWorkerWorkspaceAccessReconciler,
  resolveIsolatedWorkerWorkspaceAccessTarget,
} from './reconcileIsolatedWorkerWorkspaceAccess';

function resolveAclBinary(name: 'setfacl' | 'getfacl'): string {
  const dirs = [...String(process.env.PATH ?? '').split(delimiter).filter(Boolean), '/usr/bin', '/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try next standard location.
    }
  }
  return name;
}

const setfaclBin = resolveAclBinary('setfacl');
const getfaclBin = resolveAclBinary('getfacl');
const aclToolsAvailable = process.platform === 'linux'
  && [setfaclBin, getfaclBin].every(cmd => spawnSync(cmd, ['--version']).status === 0);

function readAclLines(path: string): string[] {
  return execFileSync(getfaclBin, ['-n', '-c', '-p', path], { encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

describe('resolveIsolatedWorkerWorkspaceAccessTarget', () => {
  it('returns null on non-Linux or when isolation is disabled', async () => {
    await expect(resolveIsolatedWorkerWorkspaceAccessTarget({
      snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
      isCustodianRequester: true,
      platform: 'darwin',
      resolveOwnerMemberUid: async () => 2501,
    })).resolves.toBeNull();

    await expect(resolveIsolatedWorkerWorkspaceAccessTarget({
      snapshot: { enabled: false, status: { kind: 'disabled' } },
      isCustodianRequester: true,
      platform: 'linux',
      resolveOwnerMemberUid: async () => 2501,
    })).resolves.toBeNull();
  });

  it('selects exact_uid for custodian on linuxUsersV1 and refuses non-custodian guests', async () => {
    const resolveOwnerMemberUid = vi.fn(async () => 2501);
    const snapshot = {
      enabled: true,
      memberProvisioning: 'linuxUsersV1' as const,
      status: { kind: 'effective' },
    };

    await expect(resolveIsolatedWorkerWorkspaceAccessTarget({
      snapshot,
      isCustodianRequester: true,
      platform: 'linux',
      resolveOwnerMemberUid,
    })).resolves.toEqual({ kind: 'exact_uid', uid: 2501 });
    expect(resolveOwnerMemberUid).toHaveBeenCalledTimes(1);

    // Cross-member isolation: a guest requester must NEVER be granted access to daemon-owned files.
    await expect(resolveIsolatedWorkerWorkspaceAccessTarget({
      snapshot,
      isCustodianRequester: false,
      platform: 'linux',
      resolveOwnerMemberUid,
    })).resolves.toBeNull();
    expect(resolveOwnerMemberUid).toHaveBeenCalledTimes(1);
  });

  it('selects shared_group fast-path on sharedAgent when daemon belongs to happier-workspace, else exact_uid', async () => {
    const snapshot = {
      enabled: true,
      status: { kind: 'effective' },
      localTransport: { agentUid: 988 },
    };

    await expect(resolveIsolatedWorkerWorkspaceAccessTarget({
      snapshot,
      isCustodianRequester: true,
      platform: 'linux',
      resolveWorkspaceGid: async () => 1005,
      readProcessGroups: () => [1000, 1005],
    })).resolves.toEqual({ kind: 'shared_group', gid: 1005 });

    await expect(resolveIsolatedWorkerWorkspaceAccessTarget({
      snapshot,
      isCustodianRequester: true,
      platform: 'linux',
      resolveWorkspaceGid: async () => 1005,
      readProcessGroups: () => [1000],
    })).resolves.toEqual({ kind: 'exact_uid', uid: 988 });

    // Non-effective sharedAgent fails closed as a no-op.
    await expect(resolveIsolatedWorkerWorkspaceAccessTarget({
      snapshot: { enabled: true, status: { kind: 'unavailable' } },
      isCustodianRequester: true,
      platform: 'linux',
      resolveWorkspaceGid: async () => 1005,
      readProcessGroups: () => [1000, 1005],
    })).resolves.toBeNull();
  });
});

describe.skipIf(process.platform !== 'linux')('createIsolatedWorkerWorkspaceAccessReconciler', () => {
  const disposers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (disposers.length > 0) {
      await disposers.pop()?.();
    }
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    disposers.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  it.skipIf(!aclToolsAvailable)(
    'grants exact-UID ACLs on linuxUsersV1 for custodian worker copy while denying other members (group/other ---)',
    async () => {
      const root = await makeTempDir('happier-w3b-linux-users-');
      await chmod(root, 0o700);
      await writeFile(join(root, 'public.txt'), 'RWS-CUT48-WORKER-PUBLIC\n', { mode: 0o600 });
      await writeFile(join(root, 'run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o700 });
      await mkdir(join(root, '.happier'), { mode: 0o700 });
      await writeFile(join(root, '.happier', 'project.json'), '{}', { mode: 0o600 });

      const ownerMemberUid = 65534;
      const guestMemberUid = 65533;
      const setfaclCalls: string[][] = [];
      const reconciler = createIsolatedWorkerWorkspaceAccessReconciler({
        runSetfacl: async args => {
          setfaclCalls.push([...args]);
          execFileSync(setfaclBin, [...args]);
        },
      });
      disposers.push(() => reconciler.dispose());

      const stats = await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });

      expect(stats.mode).toBe('full');
      expect(stats.entriesMutated).toBe(5);
      expect(setfaclCalls.length).toBeLessThanOrEqual(3);

      const fileAcl = readAclLines(join(root, 'public.txt'));
      expect(fileAcl).toContain(`user:${ownerMemberUid}:rw-`);
      expect(fileAcl).toContain('group::---');
      expect(fileAcl).toContain('other::---');
      expect(fileAcl.some(line => line.startsWith(`user:${guestMemberUid}:`))).toBe(false);

      const execAcl = readAclLines(join(root, 'run.sh'));
      expect(execAcl).toContain(`user:${ownerMemberUid}:rwx`);
      expect(execAcl).toContain('other::---');

      const dirAcl = readAclLines(join(root, '.happier'));
      expect(dirAcl).toContain(`user:${ownerMemberUid}:rwx`);
      expect(dirAcl).toContain(`default:user:${ownerMemberUid}:rwx`);
      expect(dirAcl).toContain(`default:user:${process.getuid!()}:rwx`);
      expect(dirAcl).toContain('group::---');
      expect(dirAcl).toContain('other::---');

      // Warm steady-state dequeue: O(1), 0 tree walks, 0 setfacl forks!
      const warm = await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(warm).toEqual({
        mode: 'warm_clean',
        entriesInspected: 0,
        entriesMutated: 0,
        aclCommandsExecuted: 0,
      });
    },
  );

  it.skipIf(!aclToolsAvailable)(
    'reconciles newly synced files incrementally in O(1) and batches cold runs instead of forking per file',
    async () => {
      const root = await makeTempDir('happier-w3b-perf-');
      await chmod(root, 0o700);
      for (let i = 0; i < 150; i += 1) {
        await writeFile(join(root, `file-${i}.txt`), `payload-${i}`, { mode: 0o600 });
      }

      const ownerMemberUid = 65534;
      const reconciler = createIsolatedWorkerWorkspaceAccessReconciler();
      disposers.push(() => reconciler.dispose());

      const cold = await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(cold.mode).toBe('full');
      expect(cold.entriesMutated).toBe(151);
      // 150 files (3 batches of 64) + 1 root dir = 4 batched setfacl calls, NOT 151!
      expect(cold.aclCommandsExecuted).toBeLessThanOrEqual(4);

      // Warm steady-state: 0 entries inspected, 0 setfacl forks!
      const steady = await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(steady).toEqual({
        mode: 'warm_clean',
        entriesInspected: 0,
        entriesMutated: 0,
        aclCommandsExecuted: 0,
      });

      // Simulate Mutagen syncing 1 new probe file (Case 2B sync barrier probe).
      await writeFile(join(root, 'q2-sync-barrier-probe.txt'), 'barrier-ok', { mode: 0o600 });
      const incremental = await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(incremental.mode).toBe('incremental');
      // Only the newly synced file (+ at most root stat) was touched, NOT the other 150 files!
      expect(incremental.entriesMutated).toBe(1);
      expect(incremental.aclCommandsExecuted).toBe(1);
      expect(readAclLines(join(root, 'q2-sync-barrier-probe.txt'))).toContain(`user:${ownerMemberUid}:rw-`);

      // Simulate Mutagen creating a brand-new nested directory + file inside it (inotify race).
      await mkdir(join(root, 'nested'), { mode: 0o700 });
      await writeFile(join(root, 'nested', 'deep.txt'), 'deep-ok', { mode: 0o600 });
      const nestedRun = await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(nestedRun.mode).toBe('incremental');
      expect(readAclLines(join(root, 'nested'))).toContain(`user:${ownerMemberUid}:rwx`);
      expect(readAclLines(join(root, 'nested', 'deep.txt'))).toContain(`user:${ownerMemberUid}:rw-`);

      // Subsequent steady-state call filters out any self-induced IN_ATTRIB events with 0 setfacl forks!
      const postNested = await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(postNested.aclCommandsExecuted).toBe(0);
      expect(postNested.entriesMutated).toBe(0);
    },
  );

  it('applies canonical group/mode fast-path on sharedAgent with zero setfacl forks and zero world bits', async () => {
    const root = await makeTempDir('happier-w3b-shared-group-');
    await chmod(root, 0o700);
    await writeFile(join(root, 'public.txt'), 'hello', { mode: 0o600 });
    await writeFile(join(root, 'exec.sh'), '#!/bin/sh\n', { mode: 0o700 });
    await mkdir(join(root, 'sub'), { mode: 0o700 });

    const ownGid = process.getgid!();
    const runSetfacl = vi.fn(async () => {
      throw new Error('setfacl must not run on shared_group fast-path');
    });
    const reconciler = createIsolatedWorkerWorkspaceAccessReconciler({
      resolveWorkspaceGid: async () => ownGid,
      readProcessGroups: () => [ownGid],
      runSetfacl,
    });
    disposers.push(() => reconciler.dispose());

    const cold = await reconciler.reconcile({
      rootPath: root,
      snapshot: { enabled: true, status: { kind: 'effective' } },
      isCustodianRequester: true,
    });

    expect(cold.mode).toBe('full');
    expect(cold.aclCommandsExecuted).toBe(0);
    expect(runSetfacl).not.toHaveBeenCalled();

    const fileStat = await stat(join(root, 'public.txt'));
    expect(fileStat.mode & 0o7777).toBe(0o660);
    expect(fileStat.mode & 0o007).toBe(0);

    const execStat = await stat(join(root, 'exec.sh'));
    expect(execStat.mode & 0o7777).toBe(0o770);
    expect(execStat.mode & 0o007).toBe(0);

    const subStat = await stat(join(root, 'sub'));
    expect(subStat.mode & 0o7777).toBe(0o2770);
    expect(subStat.mode & 0o007).toBe(0);

    const rootStat = await stat(root);
    expect(rootStat.mode & 0o7777).toBe(0o2770);
    expect(rootStat.mode & 0o007).toBe(0);
  });

  it.skipIf(!aclToolsAvailable)(
    'never follows symlinks, never mutates hardlinked host files (nlink > 1), and refuses symlinked root',
    async () => {
      const outer = await makeTempDir('happier-w3b-safety-');
      const secretDir = join(outer, 'host-secret');
      await mkdir(secretDir, { mode: 0o700 });
      const secretFile = join(secretDir, 'id_ed25519');
      await writeFile(secretFile, 'PRIVATE-KEY', { mode: 0o600 });

      const hardlinkTarget = join(outer, 'host-hardlink-secret.txt');
      await writeFile(hardlinkTarget, 'SHARED-INODE', { mode: 0o600 });

      const root = join(outer, 'worker-copy');
      await mkdir(root, { mode: 0o700 });
      await writeFile(join(root, 'legit.txt'), 'ok', { mode: 0o600 });
      await symlink(secretFile, join(root, 'link-to-secret'));
      await symlink(secretDir, join(root, 'link-to-secret-dir'));
      await link(hardlinkTarget, join(root, 'hardlink-entry.txt'));

      const symlinkRoot = join(outer, 'symlink-root');
      await symlink(secretDir, symlinkRoot);

      const ownerMemberUid = 65534;
      const reconciler = createIsolatedWorkerWorkspaceAccessReconciler();
      disposers.push(() => reconciler.dispose());

      // Symlinked root must be refused as no-op and secretDir untouched.
      const symlinkRootResult = await reconciler.reconcile({
        rootPath: symlinkRoot,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(symlinkRootResult.mode).toBe('noop');
      expect((await lstat(secretFile)).mode & 0o777).toBe(0o600);
      expect(readAclLines(secretFile).some(line => line.startsWith(`user:${ownerMemberUid}:`))).toBe(false);

      // Reconcile the real worker copy containing symlinks + hardlink.
      await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });

      // Legitimate file was granted access.
      expect(readAclLines(join(root, 'legit.txt'))).toContain(`user:${ownerMemberUid}:rw-`);

      // Symlinked file & directory targets outside root were NEVER modified.
      expect((await lstat(secretFile)).mode & 0o777).toBe(0o600);
      expect(readAclLines(secretFile).some(line => line.startsWith(`user:${ownerMemberUid}:`))).toBe(false);
      expect((await lstat(secretDir)).mode & 0o777).toBe(0o700);
      expect(readAclLines(secretDir).some(line => line.startsWith(`user:${ownerMemberUid}:`))).toBe(false);

      // Hardlink was preserved (nlink === 2, same inode) AND never had permissions/ACL weakened.
      const hardlinkBefore = await lstat(hardlinkTarget);
      const hardlinkCopy = await lstat(join(root, 'hardlink-entry.txt'));
      expect(hardlinkBefore.ino).toBe(hardlinkCopy.ino);
      expect(hardlinkBefore.nlink).toBe(2);
      expect(hardlinkBefore.mode & 0o777).toBe(0o600);
      expect(readAclLines(hardlinkTarget).some(line => line.startsWith(`user:${ownerMemberUid}:`))).toBe(false);
    },
  );

  it.skipIf(!aclToolsAvailable)(
    'falls back safely when fs.watch throws ENOSPC and skips already-granted inodes with 0 setfacl forks',
    async () => {
      const root = await makeTempDir('happier-w3b-watch-fallback-');
      await chmod(root, 0o700);
      await writeFile(join(root, 'a.txt'), 'a', { mode: 0o600 });
      await writeFile(join(root, 'b.txt'), 'b', { mode: 0o600 });
      await mkdir(join(root, 'sub'), { mode: 0o700 });
      await writeFile(join(root, 'sub', 'd.txt'), 'd', { mode: 0o600 });

      const ownerMemberUid = 65534;
      const reconciler = createIsolatedWorkerWorkspaceAccessReconciler({
        watchRoot: () => {
          throw Object.assign(new Error('ENOSPC: watch limit reached'), { code: 'ENOSPC' });
        },
      });
      disposers.push(() => reconciler.dispose());

      const first = await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(first.mode).toBe('full');
      expect(first.entriesMutated).toBe(5);

      // Second run without watcher still skips unchanged inodes with 0 setfacl calls!
      const second = await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(second.entriesMutated).toBe(0);
      expect(second.aclCommandsExecuted).toBe(0);

      // A newly created file still gets granted even without fs.watch, while unchanged
      // files and subdirectories (`a.txt`, `b.txt`, `sub`, `sub/d.txt`) are skipped!
      await writeFile(join(root, 'c.txt'), 'c', { mode: 0o600 });
      const third = await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      // Only `c.txt` and parent `root` (whose kernel ctime updated on entry creation) mutate.
      expect(third.entriesMutated).toBe(2);
      expect(third.aclCommandsExecuted).toBeLessThanOrEqual(2);
      expect(readAclLines(join(root, 'c.txt'))).toContain(`user:${ownerMemberUid}:rw-`);
    },
  );

  it('skips daemon-owned 0000 files gracefully without aborting reconciliation or poisoning fullScanNeeded', async () => {
    const root = await makeTempDir('happier-w3b-zero-mode-');
    await chmod(root, 0o700);
    const lockedPath = join(root, 'locked-zero.txt');
    const normalPath = join(root, 'normal.txt');
    await writeFile(lockedPath, 'unreadable', { mode: 0o600 });
    await chmod(lockedPath, 0o000);
    await writeFile(normalPath, 'readable', { mode: 0o600 });
    disposers.push(async () => {
      await chmod(lockedPath, 0o600).catch(() => undefined);
    });

    const ownGid = process.getgid!();
    const sharedGroupReconciler = createIsolatedWorkerWorkspaceAccessReconciler({
      resolveWorkspaceGid: async () => ownGid,
      readProcessGroups: () => [ownGid],
    });
    disposers.push(() => sharedGroupReconciler.dispose());

    const sharedCold = await sharedGroupReconciler.reconcile({
      rootPath: root,
      snapshot: { enabled: true, status: { kind: 'effective' } },
      isCustodianRequester: true,
    });
    expect(sharedCold.mode).toBe('full');
    expect((await stat(normalPath)).mode & 0o7777).toBe(0o660);
    expect((await stat(lockedPath)).mode & 0o7777).toBe(0o000);

    // Must not have tripped fullScanNeeded=true forever; next call is warm_clean.
    const sharedWarm = await sharedGroupReconciler.reconcile({
      rootPath: root,
      snapshot: { enabled: true, status: { kind: 'effective' } },
      isCustodianRequester: true,
    });
    expect(sharedWarm).toEqual({
      mode: 'warm_clean',
      entriesInspected: 0,
      entriesMutated: 0,
      aclCommandsExecuted: 0,
    });

    if (aclToolsAvailable) {
      const aclRoot = await makeTempDir('happier-w3b-zero-acl-');
      await chmod(aclRoot, 0o700);
      const setuidZeroPath = join(aclRoot, 'setuid-zero.bin');
      const aclNormalPath = join(aclRoot, 'ok.txt');
      await writeFile(setuidZeroPath, 'special', { mode: 0o600 });
      await chmod(setuidZeroPath, 0o4000);
      await writeFile(aclNormalPath, 'ok', { mode: 0o600 });
      disposers.push(async () => {
        await chmod(setuidZeroPath, 0o600).catch(() => undefined);
      });

      const ownerMemberUid = 65534;
      const aclReconciler = createIsolatedWorkerWorkspaceAccessReconciler();
      disposers.push(() => aclReconciler.dispose());

      const aclCold = await aclReconciler.reconcile({
        rootPath: aclRoot,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(aclCold.mode).toBe('full');
      expect(readAclLines(aclNormalPath)).toContain(`user:${ownerMemberUid}:rw-`);
      // Unstrippable setuid 0000 file must be skipped without granting ACLs.
      expect(readAclLines(setuidZeroPath).some(line => line.startsWith(`user:${ownerMemberUid}:`))).toBe(false);

      const aclWarm = await aclReconciler.reconcile({
        rootPath: aclRoot,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(aclWarm).toEqual({
        mode: 'warm_clean',
        entriesInspected: 0,
        entriesMutated: 0,
        aclCommandsExecuted: 0,
      });
    }
  });

  it.skipIf(!aclToolsAvailable)(
    'falls back to per-item setfacl when a multi-FD batch hits one bad entry and still grants the remaining files',
    async () => {
      const root = await makeTempDir('happier-w3b-batch-fallback-');
      await chmod(root, 0o700);
      const good1 = join(root, 'good-1.txt');
      const bad = join(root, 'bad.txt');
      const good2 = join(root, 'good-2.txt');
      await writeFile(good1, 'one', { mode: 0o600 });
      await writeFile(bad, 'bad', { mode: 0o600 });
      await writeFile(good2, 'two', { mode: 0o600 });
      const badIno = (await stat(bad, { bigint: true })).ino;

      const ownerMemberUid = 65534;
      const calls: string[][] = [];
      const reconciler = createIsolatedWorkerWorkspaceAccessReconciler({
        runSetfacl: async args => {
          calls.push([...args]);
          const sepIdx = args.indexOf('--');
          const targets = sepIdx >= 0 ? args.slice(sepIdx + 1) : [];
          let hasBad = false;
          for (const fdPath of targets) {
            const st = await stat(fdPath, { bigint: true });
            if (st.ino === badIno) {
              hasBad = true;
              break;
            }
          }
          if (hasBad) {
            throw Object.assign(
              new Error(`setfacl: ${targets[0]}: Operation not permitted`),
              { code: 1, stderr: `setfacl: ${targets[0]}: Operation not permitted\n` },
            );
          }
          execFileSync(setfaclBin, [...args]);
        },
      });
      disposers.push(() => reconciler.dispose());

      const cold = await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });

      expect(cold.mode).toBe('full');
      expect(readAclLines(good1)).toContain(`user:${ownerMemberUid}:rw-`);
      expect(readAclLines(good2)).toContain(`user:${ownerMemberUid}:rw-`);
      expect(readAclLines(bad).some(line => line.startsWith(`user:${ownerMemberUid}:`))).toBe(false);
      // Confirm multi-FD batch was attempted first and then fell back to per-item calls.
      expect(calls.some(call => call.slice(call.indexOf('--') + 1).length > 1)).toBe(true);
      expect(calls.filter(call => call.slice(call.indexOf('--') + 1).length === 1).length).toBeGreaterThanOrEqual(3);

      // Next warm call returns warm_clean (good entries cached, fullScanNeeded not tripped).
      const warm = await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(warm).toEqual({
        mode: 'warm_clean',
        entriesInspected: 0,
        entriesMutated: 0,
        aclCommandsExecuted: 0,
      });
    },
  );

  it.skipIf(!aclToolsAvailable)(
    'grants minimal --x traversal ACL on daemon-owned 0700 ancestors without exposing contents or modifying group/other bits',
    async () => {
      const outer = await makeTempDir('happier-w3b-ancestor-');
      await chmod(outer, 0o755);
      const daemonHome = join(outer, 'daemon-home');
      const workspacesDir = join(daemonHome, 'workspaces');
      const workerCopy = join(workspacesDir, 'worker-copy');
      await mkdir(daemonHome, { mode: 0o700 });
      await mkdir(workspacesDir, { mode: 0o700 });
      await mkdir(workerCopy, { mode: 0o700 });
      const siblingSecret = join(daemonHome, 'private-secret.txt');
      await writeFile(siblingSecret, 'TOP-SECRET', { mode: 0o600 });
      await writeFile(join(workerCopy, 'public.txt'), 'worker-file', { mode: 0o600 });

      const ownerMemberUid = 65534;
      const setfaclCalls: string[][] = [];
      const reconciler = createIsolatedWorkerWorkspaceAccessReconciler({
        runSetfacl: async args => {
          setfaclCalls.push([...args]);
          execFileSync(setfaclBin, [...args]);
        },
      });
      disposers.push(() => reconciler.dispose());

      const cold = await reconciler.reconcile({
        rootPath: workerCopy,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(cold.mode).toBe('full');

      for (const ancestor of [daemonHome, workspacesDir]) {
        const acl = readAclLines(ancestor);
        expect(acl).toContain(`user:${ownerMemberUid}:--x`);
        expect(acl).toContain('group::---');
        expect(acl).toContain('other::---');
        expect(acl.some(line => line.startsWith('default:'))).toBe(false);
        expect((await stat(ancestor)).mode & 0o007).toBe(0);
      }

      // Outer 0755 ancestor already has world +x and must NOT be touched with an ACL.
      expect(readAclLines(outer).some(line => line.startsWith(`user:${ownerMemberUid}:`))).toBe(false);

      // Sibling secret inside daemonHome must remain completely untouched.
      expect(readAclLines(siblingSecret).some(line => line.startsWith(`user:${ownerMemberUid}:`))).toBe(false);
      expect(readAclLines(join(workerCopy, 'public.txt'))).toContain(`user:${ownerMemberUid}:rw-`);

      // Warm steady-state must cache ancestor grants and execute 0 setfacl forks!
      const callsBeforeWarm = setfaclCalls.length;
      const warm = await reconciler.reconcile({
        rootPath: workerCopy,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(warm).toEqual({
        mode: 'warm_clean',
        entriesInspected: 0,
        entriesMutated: 0,
        aclCommandsExecuted: 0,
      });
      expect(setfaclCalls.length).toBe(callsBeforeWarm);
    },
  );

  it.skipIf(!aclToolsAvailable)(
    'picks up writes inside an existing subdirectory even when root mtime/ctime is unchanged and starts watcher before cold walk',
    async () => {
      const root = await makeTempDir('happier-w3b-subdir-inotify-');
      await chmod(root, 0o700);
      await mkdir(join(root, 'sub'), { mode: 0o700 });
      await writeFile(join(root, 'sub', 'initial.txt'), 'init', { mode: 0o600 });

      const ownerMemberUid = 65534;
      const lifecycleOrder: string[] = [];
      let injectedDuringCold = false;
      const reconciler = createIsolatedWorkerWorkspaceAccessReconciler({
        watchRoot: (canonicalRoot, onEvent) => {
          lifecycleOrder.push('watchRoot');
          return watch(canonicalRoot, { recursive: true, persistent: false }, onEvent);
        },
        runSetfacl: async args => {
          lifecycleOrder.push('runSetfacl');
          execFileSync(setfaclBin, [...args]);
          if (!injectedDuringCold) {
            injectedDuringCold = true;
            // Simulate a concurrent Mutagen write during the cold walk!
            await writeFile(join(root, 'sub', 'during-cold.txt'), 'race-file', { mode: 0o600 });
          }
        },
      });
      disposers.push(() => reconciler.dispose());

      const cold = await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(cold.mode).toBe('full');
      expect(lifecycleOrder[0]).toBe('watchRoot');

      // Either drained at end of cold scan or picked up on the very next reconcile; never missed!
      await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(readAclLines(join(root, 'sub', 'during-cold.txt'))).toContain(`user:${ownerMemberUid}:rw-`);

      // Ensure steady state before testing subdirectory write.
      const beforeWriteRootStat = await stat(root, { bigint: true });
      const nestedProbe = join(root, 'sub', 'nested-probe.txt');
      await writeFile(nestedProbe, 'nested-probe-ok', { mode: 0o600 });
      const afterWriteRootStat = await stat(root, { bigint: true });
      // Writing inside existing `sub/` leaves root directory mtime/ctime unchanged!
      expect(afterWriteRootStat.mtimeNs).toBe(beforeWriteRootStat.mtimeNs);
      expect(afterWriteRootStat.ctimeNs).toBe(beforeWriteRootStat.ctimeNs);

      const incremental = await reconciler.reconcile({
        rootPath: root,
        snapshot: { enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } },
        isCustodianRequester: true,
        resolveOwnerMemberUid: async () => ownerMemberUid,
      });
      expect(incremental.mode).toBe('incremental');
      expect(readAclLines(nestedProbe)).toContain(`user:${ownerMemberUid}:rw-`);
    },
  );
});
