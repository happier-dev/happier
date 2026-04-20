import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { TrackedSession } from '@/daemon/types';

import {
  migrateTrackedSessionProcessesOutOfDaemonServiceCgroup,
  moveProcessOutOfDaemonServiceCgroup,
} from './migrateTrackedSessionsOutOfDaemonServiceCgroup';

async function writeProcCgroup(procfsRootDir: string, pid: number, relativePath: string): Promise<void> {
  const procDir = join(procfsRootDir, String(pid));
  await mkdir(procDir, { recursive: true });
  await writeFile(join(procDir, 'cgroup'), `0::${relativePath}\n`, 'utf8');
}

async function writeProcChildren(procfsRootDir: string, pid: number, childPids: readonly number[]): Promise<void> {
  const taskDir = join(procfsRootDir, String(pid), 'task', String(pid));
  await mkdir(taskDir, { recursive: true });
  const payload = childPids.length > 0 ? `${childPids.join(' ')}\n` : '';
  await writeFile(join(taskDir, 'children'), payload, 'utf8');
}

describe('migrateTrackedSessionsOutOfDaemonServiceCgroup', () => {
  let sandboxDir: string | null = null;

  afterEach(async () => {
    if (!sandboxDir) return;
    await rm(sandboxDir, { recursive: true, force: true });
    sandboxDir = null;
  });

  it('moves reattached daemon-started tracked session process trees out of the daemon service subtree into sibling scopes', async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-migration-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    const cgroupRootDir = join(sandboxDir, 'sys', 'fs', 'cgroup');
    const daemonServiceRelativePath = '/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service';

    await writeProcCgroup(procfsRootDir, 111, daemonServiceRelativePath);
    await writeProcCgroup(procfsRootDir, 6480, daemonServiceRelativePath);
    await writeProcCgroup(procfsRootDir, 6481, daemonServiceRelativePath);
    await writeProcCgroup(procfsRootDir, 6482, daemonServiceRelativePath);
    await writeProcCgroup(procfsRootDir, 9761, `${daemonServiceRelativePath}/nested-legacy-runner`);
    await writeProcCgroup(
      procfsRootDir,
      9802,
      '/user.slice/user-501.slice/user@501.service/app.slice/happier-session-9802.scope',
    );
    await writeProcChildren(procfsRootDir, 6480, [6481]);
    await writeProcChildren(procfsRootDir, 6481, [6482]);
    await writeProcChildren(procfsRootDir, 6482, []);
    await writeProcChildren(procfsRootDir, 9761, []);
    await mkdir(join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/app.slice'), { recursive: true });
    await mkdir(join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service'), { recursive: true });
    await writeFile(
      join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service/cgroup.procs'),
      '111\n6480\n6481\n6482\n9761\n9802\n',
      'utf8',
    );

    const trackedSessions = [
      {
        pid: 6480,
        startedBy: 'daemon',
        happySessionId: 'sess-6480',
        reattachedFromDiskMarker: true,
      },
      {
        pid: 9761,
        startedBy: 'daemon',
        happySessionId: 'sess-9761',
        reattachedFromDiskMarker: true,
      },
    ] satisfies TrackedSession[];

    const migrated = await migrateTrackedSessionProcessesOutOfDaemonServiceCgroup({
      trackedSessions,
      daemonPid: 111,
      procfsRootDir,
      cgroupRootDir,
    });

    expect(migrated).toEqual([
      {
        pid: 6480,
        targetRelativePath: '/user.slice/user-501.slice/user@501.service/happier-session-6480.scope',
      },
      {
        pid: 6481,
        targetRelativePath: '/user.slice/user-501.slice/user@501.service/happier-session-6481.scope',
      },
      {
        pid: 6482,
        targetRelativePath: '/user.slice/user-501.slice/user@501.service/happier-session-6482.scope',
      },
      {
        pid: 9761,
        targetRelativePath: '/user.slice/user-501.slice/user@501.service/happier-session-9761.scope',
      },
      {
        pid: 9802,
        targetRelativePath: '/user.slice/user-501.slice/user@501.service/happier-session-9802.scope',
      },
    ]);

    expect(
      await readFile(
        join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/happier-session-6480.scope/cgroup.procs'),
        'utf8',
      ),
    ).toBe('6480\n');
    expect(
      await readFile(
        join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/happier-session-9761.scope/cgroup.procs'),
        'utf8',
      ),
    ).toBe('9761\n');
    expect(
      await readFile(
        join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/happier-session-6482.scope/cgroup.procs'),
        'utf8',
      ),
    ).toBe('6482\n');
    expect(
      await readFile(
        join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/happier-session-9802.scope/cgroup.procs'),
        'utf8',
      ),
    ).toBe('9802\n');
  });

  it('skips sessions that are not daemon-reattached or already outside the daemon service subtree', async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-migration-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    const cgroupRootDir = join(sandboxDir, 'sys', 'fs', 'cgroup');
    const daemonServiceRelativePath = '/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service';

    await writeProcCgroup(procfsRootDir, 111, daemonServiceRelativePath);
    await writeProcCgroup(procfsRootDir, 222, '/user.slice/user-501.slice/session-6.scope');
    await writeProcCgroup(procfsRootDir, 333, daemonServiceRelativePath);
    await mkdir(join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/app.slice'), { recursive: true });

    const trackedSessions = [
      {
        pid: 222,
        startedBy: 'daemon',
        happySessionId: 'sess-outside',
        reattachedFromDiskMarker: true,
      },
      {
        pid: 333,
        startedBy: 'terminal',
        happySessionId: 'sess-external',
        reattachedFromDiskMarker: true,
      },
      {
        pid: 444,
        startedBy: 'daemon',
        happySessionId: 'sess-not-reattached',
      },
    ] satisfies TrackedSession[];

    const migrated = await migrateTrackedSessionProcessesOutOfDaemonServiceCgroup({
      trackedSessions,
      daemonPid: 111,
      procfsRootDir,
      cgroupRootDir,
    });

    expect(migrated).toEqual([]);
  });

  it('moves a newly spawned pid out of the daemon service subtree when it is still colocated with the daemon', async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-migration-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    const cgroupRootDir = join(sandboxDir, 'sys', 'fs', 'cgroup');
    const daemonServiceRelativePath = '/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service';

    await writeProcCgroup(procfsRootDir, 111, daemonServiceRelativePath);
    await writeProcCgroup(procfsRootDir, 555, daemonServiceRelativePath);
    await mkdir(join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/app.slice'), { recursive: true });

    const migration = await moveProcessOutOfDaemonServiceCgroup({
      pid: 555,
      daemonPid: 111,
      procfsRootDir,
      cgroupRootDir,
    });

    expect(migration).toEqual({
      pid: 555,
      targetRelativePath: '/user.slice/user-501.slice/user@501.service/happier-session-555.scope',
    });
    expect(
      await readFile(
        join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/happier-session-555.scope/cgroup.procs'),
        'utf8',
      ),
    ).toBe('555\n');
  });

  it('moves a legacy app.slice sibling scope pid out of the daemon app.slice subtree', async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-migration-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    const cgroupRootDir = join(sandboxDir, 'sys', 'fs', 'cgroup');
    const daemonServiceRelativePath = '/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service';

    await writeProcCgroup(procfsRootDir, 111, daemonServiceRelativePath);
    await writeProcCgroup(
      procfsRootDir,
      556,
      '/user.slice/user-501.slice/user@501.service/app.slice/happier-session-556.scope',
    );
    await mkdir(join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/app.slice'), { recursive: true });

    const migration = await moveProcessOutOfDaemonServiceCgroup({
      pid: 556,
      daemonPid: 111,
      procfsRootDir,
      cgroupRootDir,
    });

    expect(migration).toEqual({
      pid: 556,
      targetRelativePath: '/user.slice/user-501.slice/user@501.service/happier-session-556.scope',
    });
    expect(
      await readFile(
        join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/happier-session-556.scope/cgroup.procs'),
        'utf8',
      ),
    ).toBe('556\n');
  });

  it('does not throw when it cannot write to the cgroup filesystem (best-effort migration)', async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-migration-write-fail-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    const cgroupRootDir = join(sandboxDir, 'sys', 'fs', 'cgroup');
    const daemonServiceRelativePath = '/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service';

    await mkdir(join(sandboxDir, 'sys', 'fs'), { recursive: true });
    await writeFile(cgroupRootDir, 'not-a-dir\n', 'utf8');

    await writeProcCgroup(procfsRootDir, 111, daemonServiceRelativePath);
    await writeProcCgroup(procfsRootDir, 555, daemonServiceRelativePath);

    await expect(moveProcessOutOfDaemonServiceCgroup({
      pid: 555,
      daemonPid: 111,
      procfsRootDir,
      cgroupRootDir,
    })).resolves.toBeNull();
  });

  it('moves residual legacy happier-session scopes under app.slice even when they are not listed in the daemon service cgroup', async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-migration-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    const cgroupRootDir = join(sandboxDir, 'sys', 'fs', 'cgroup');
    const daemonServiceRelativePath = '/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service';

    await writeProcCgroup(procfsRootDir, 111, daemonServiceRelativePath);
    await writeProcCgroup(
      procfsRootDir,
      15161,
      '/user.slice/user-501.slice/user@501.service/app.slice/happier-session-15161.scope',
    );
    await mkdir(join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service'), {
      recursive: true,
    });
    await writeFile(
      join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service/cgroup.procs'),
      '111\n',
      'utf8',
    );
    await mkdir(join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/app.slice/happier-session-15161.scope'), {
      recursive: true,
    });
    await writeFile(
      join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/app.slice/happier-session-15161.scope/cgroup.procs'),
      '15161\n',
      'utf8',
    );

    const migrated = await migrateTrackedSessionProcessesOutOfDaemonServiceCgroup({
      trackedSessions: [],
      daemonPid: 111,
      procfsRootDir,
      cgroupRootDir,
    });

    expect(migrated).toContainEqual({
      pid: 15161,
      targetRelativePath: '/user.slice/user-501.slice/user@501.service/happier-session-15161.scope',
    });
    expect(
      await readFile(
        join(cgroupRootDir, '/user.slice/user-501.slice/user@501.service/happier-session-15161.scope/cgroup.procs'),
        'utf8',
      ),
    ).toBe('15161\n');
  });
});
