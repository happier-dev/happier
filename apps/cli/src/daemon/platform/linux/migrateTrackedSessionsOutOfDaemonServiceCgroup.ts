import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

import type { TrackedSession } from '@/daemon/types';
import { readUnifiedProcessCgroupRelativePath } from './readUnifiedProcessCgroupRelativePath';
import {
  resolveDaemonLegacySessionScopeSubtreeRelativePath,
  resolveDaemonSessionScopeBaseRelativePath,
} from './resolveDaemonSessionScopeBaseRelativePath';

type ProcessCgroupMigration = Readonly<{
  pid: number;
  targetRelativePath: string;
}>;

function normalizePid(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

async function readProcessChildren(
  pid: number,
  procfsRootDir: string,
): Promise<readonly number[]> {
  try {
    const raw = await readFile(join(procfsRootDir, String(pid), 'task', String(pid), 'children'), 'utf8');
    return raw
      .trim()
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

async function collectProcessTreePids(params: Readonly<{
  rootPid: number;
  procfsRootDir: string;
}>): Promise<readonly number[]> {
  const discovered = new Set<number>();
  const queue: number[] = [params.rootPid];

  while (queue.length > 0) {
    const pid = queue.shift();
    if (!pid || discovered.has(pid)) {
      continue;
    }
    discovered.add(pid);
    const children = await readProcessChildren(pid, params.procfsRootDir);
    for (const childPid of children) {
      if (!discovered.has(childPid)) {
        queue.push(childPid);
      }
    }
  }

  return Array.from(discovered);
}

function isInCgroupSubtree(params: Readonly<{
  currentRelativePath: string;
  subtreeRelativePath: string;
}>): boolean {
  return (
    params.currentRelativePath === params.subtreeRelativePath
    || params.currentRelativePath.startsWith(`${params.subtreeRelativePath}/`)
  );
}

function buildTrackedSessionSiblingScopeRelativePath(params: Readonly<{
  daemonServiceRelativePath: string;
  pid: number;
}>): string | null {
  const sessionScopeBaseRelativePath = resolveDaemonSessionScopeBaseRelativePath(params.daemonServiceRelativePath);
  if (!sessionScopeBaseRelativePath || sessionScopeBaseRelativePath === '.' || sessionScopeBaseRelativePath === params.daemonServiceRelativePath) {
    return null;
  }
  return posix.join(sessionScopeBaseRelativePath, `happier-session-${params.pid}.scope`);
}

async function moveProcessToSiblingCgroup(params: Readonly<{
  pid: number;
  targetRelativePath: string;
  cgroupRootDir: string;
}>): Promise<void> {
  const targetDir = join(params.cgroupRootDir, params.targetRelativePath);
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, 'cgroup.procs'), `${params.pid}\n`);
}

export async function moveProcessOutOfDaemonServiceCgroup(params: Readonly<{
  pid: number;
  daemonPid?: number;
  procfsRootDir?: string;
  cgroupRootDir?: string;
}>): Promise<ProcessCgroupMigration | null> {
  const pid = normalizePid(params.pid);
  if (!pid) {
    return null;
  }

  const daemonPid = normalizePid(params.daemonPid) ?? process.pid;
  const procfsRootDir = params.procfsRootDir ?? '/proc';
  const cgroupRootDir = params.cgroupRootDir ?? '/sys/fs/cgroup';

  const daemonServiceRelativePath = await readUnifiedProcessCgroupRelativePath(daemonPid, procfsRootDir);
  if (!daemonServiceRelativePath) {
    return null;
  }
  const daemonLegacySessionScopeSubtreeRelativePath =
    resolveDaemonLegacySessionScopeSubtreeRelativePath(daemonServiceRelativePath);
  const daemonSessionScopeBaseRelativePath = resolveDaemonSessionScopeBaseRelativePath(daemonServiceRelativePath);

  const currentRelativePath = await readUnifiedProcessCgroupRelativePath(pid, procfsRootDir);
  const inDaemonServiceSubtree =
    !!currentRelativePath
    && isInCgroupSubtree({
      currentRelativePath,
      subtreeRelativePath: daemonServiceRelativePath,
    });
  const inLegacySessionScopeSubtree =
    !!currentRelativePath
    && !!daemonLegacySessionScopeSubtreeRelativePath
    && daemonLegacySessionScopeSubtreeRelativePath !== daemonSessionScopeBaseRelativePath
    && isInCgroupSubtree({
      currentRelativePath,
      subtreeRelativePath: daemonLegacySessionScopeSubtreeRelativePath,
    });
  if (!currentRelativePath || (!inDaemonServiceSubtree && !inLegacySessionScopeSubtree)) {
    return null;
  }

  const targetRelativePath = buildTrackedSessionSiblingScopeRelativePath({
    daemonServiceRelativePath,
    pid,
  });
  if (!targetRelativePath) {
    return null;
  }

  try {
    await moveProcessToSiblingCgroup({
      pid,
      targetRelativePath,
      cgroupRootDir,
    });
  } catch {
    return null;
  }

  return { pid, targetRelativePath };
}

export async function migrateTrackedSessionProcessesOutOfDaemonServiceCgroup(params: Readonly<{
  trackedSessions: Iterable<TrackedSession>;
  daemonPid?: number;
  procfsRootDir?: string;
  cgroupRootDir?: string;
}>): Promise<readonly ProcessCgroupMigration[]> {
  const daemonPid = normalizePid(params.daemonPid) ?? process.pid;
  const procfsRootDir = params.procfsRootDir ?? '/proc';
  const cgroupRootDir = params.cgroupRootDir ?? '/sys/fs/cgroup';
  const migrated = new Map<number, ProcessCgroupMigration>();

  for (const trackedSession of params.trackedSessions) {
    if (trackedSession.startedBy !== 'daemon' || trackedSession.reattachedFromDiskMarker !== true) {
      continue;
    }

    const trackedPids = new Set<number>();
    const primaryPid = normalizePid(trackedSession.pid);
    if (primaryPid) trackedPids.add(primaryPid);
    const runnerPid = normalizePid(trackedSession.sessionRunnerPid);
    if (runnerPid) trackedPids.add(runnerPid);

    const processTreePids = new Set<number>();
    for (const pid of trackedPids) {
      const treePids = await collectProcessTreePids({
        rootPid: pid,
        procfsRootDir,
      });
      for (const treePid of treePids) {
        processTreePids.add(treePid);
      }
    }

    for (const pid of processTreePids) {
      if (pid === daemonPid || migrated.has(pid)) continue;

      const migration = await moveProcessOutOfDaemonServiceCgroup({
        pid,
        daemonPid: params.daemonPid,
        procfsRootDir,
        cgroupRootDir,
      });
      if (!migration) {
        continue;
      }
      migrated.set(pid, migration);
    }
  }

  return Array.from(migrated.values());
}
