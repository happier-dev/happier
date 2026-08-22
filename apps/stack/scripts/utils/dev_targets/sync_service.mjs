import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { killProcessTree, spawnProc } from '../proc/proc.mjs';
import { inspectDevTargetSync, runDevTargetCommand } from './executor.mjs';
import {
  DEV_TARGET_DISPOSABLE_REPLICA_ARTIFACT_ROOTS,
  isMutagenProjectOwnedBy,
  resolveMutagenSessionName,
} from './mutagen_project.mjs';
import {
  buildMutagenMonitorArgs,
  createMutagenMonitorLineFilter,
} from './mutagen_monitor.mjs';
import {
  resolveDevTargetMutagenRuntime,
  resolveRecoverableReplicaArtifactConflictRoots,
} from './mutagen_runtime.mjs';
import {
  ensureDevTargetSyncProject,
  INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  releaseIndependentDevTargetSyncProject,
  runDevTargetControlProcess,
} from './sync_project.mjs';

function defaultSpawnMonitor({ command, args, env, lineFilter }) {
  return spawnProc('mutagen', command, args, env, { lineFilter });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function defaultWritePreparationState({ stackBaseDir, state, env }) {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
  const temporary = `${runtime.syncServiceStateFile}.${process.pid}.tmp`;
  await mkdir(dirname(runtime.syncServiceStateFile), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, runtime.syncServiceStateFile);
}

async function defaultReadPreparationState({ stackBaseDir, env }) {
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
  const raw = await readFile(runtime.syncServiceStateFile, 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

async function defaultResumeSync({ target, env }) {
  const result = await spawnProc(
    `sync:${target.name}`,
    'mutagen',
    ['sync', 'resume', resolveMutagenSessionName(target.name)],
    env,
  ).completion;
  if (result?.code !== 0) {
    throw new Error(`[dev-targets] ${target.name} synchronization resume failed`);
  }
}

function assertUsableStatus(target, status) {
  if (status.state === 'ready' || status.state === 'synchronizing') return;
  const detail = status.lastError || status.error;
  throw new Error(
    `[dev-targets] ${target.name} synchronization is ${status.state}`
      + (detail ? `: ${detail}` : ''),
  );
}

export async function repairRecoverableDevTargetSyncConflicts(
  { target, status, sourceDir, stackBaseDir, env },
  {
    pathExists = existsSync,
    runCommand = runDevTargetCommand,
    runControl = runDevTargetControlProcess,
  } = {},
) {
  if (target.platform !== 'posix') return { repaired: false, roots: [] };
  const roots = resolveRecoverableReplicaArtifactConflictRoots(status?.session)
    .filter((root) => !pathExists(join(sourceDir, root)));
  if (roots.length === 0) return { repaired: false, roots: [] };
  for (const root of roots) {
    const result = await runCommand({
      target,
      stackBaseDir,
      cwd: '.',
      commandArgs: [
        'sh',
        '-ceu',
        [
          'repo=$1',
          'relative=$2',
          'shift 2',
          'candidate="$repo/$relative"',
          '[ -d "$candidate" ]',
          'found_marker=0',
          'for marker in "$@"; do',
          '  if [ -e "$candidate/$marker" ] || [ -L "$candidate/$marker" ]; then',
          '    found_marker=1',
          '    break',
          '  fi',
          'done',
          '[ "$found_marker" -eq 1 ]',
          'rm -rf -- "$candidate"',
        ].join('\n'),
        'hstack-sync-repair',
        target.repoDir,
        root,
        ...DEV_TARGET_DISPOSABLE_REPLICA_ARTIFACT_ROOTS,
      ],
      dependencyAdmission: 'skip',
      syncAlreadyVerified: true,
      env,
    });
    if (result?.code !== 0) {
      throw new Error(
        `[dev-targets] ${target.name} refused stale replica artifact repair for ${root}`,
      );
    }
  }
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
  const sessionName = resolveMutagenSessionName(target.name);
  for (const action of ['reset', 'flush']) {
    const result = await runControl({
      label: `sync:${target.name}`,
      command: 'mutagen',
      args: ['sync', action, sessionName],
      env: runtime.env,
    });
    if (result?.code !== 0) {
      throw new Error(`[dev-targets] ${target.name} synchronization ${action} failed after repair`);
    }
  }
  return { repaired: true, roots };
}

async function inspectAndRepairSync({
  target,
  sourceDir,
  stackBaseDir,
  env,
  inspectSync,
  repairSync,
}) {
  const status = await inspectSync({ target, stackBaseDir, env });
  const repair = await repairSync({ target, status, sourceDir, stackBaseDir, env });
  if (!repair?.repaired) return status;
  return {
    state: 'synchronizing',
    sessionName: status.sessionName,
    repairedRoots: repair.roots,
  };
}

export async function startDevTargetSyncService(
  {
    stackBaseDir,
    sourceDir,
    targets,
    detached = false,
    env = process.env,
  },
  {
    ensureProject = ensureDevTargetSyncProject,
    inspectSync = inspectDevTargetSync,
    resumeSync = defaultResumeSync,
    spawnMonitor = defaultSpawnMonitor,
    repairSync = repairRecoverableDevTargetSyncConflicts,
    writePreparationState = defaultWritePreparationState,
  } = {},
) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('[dev-targets] no targets are configured for synchronization');
  }
  const project = await ensureProject({
    stackBaseDir,
    sourceDir,
    targets,
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
    allowIndependentBorrow: false,
    env,
  });
  const startedAt = new Date().toISOString();
  await writePreparationState({
    stackBaseDir,
    env,
    state: {
      version: 1,
      state: 'preparing',
      startedAt,
      updatedAt: startedAt,
      targets: Object.fromEntries(targets.map((target) => [target.name, { state: 'pending' }])),
    },
  });
  try {
    await Promise.all(targets.map(async (target) => {
      await resumeSync({ target, env: project.env });
    }));
  } catch (error) {
    const updatedAt = new Date().toISOString();
    await writePreparationState({
      stackBaseDir,
      env,
      state: {
        version: 1,
        state: 'failed',
        startedAt,
        updatedAt,
        error: errorMessage(error),
        targets: Object.fromEntries(targets.map((target) => [target.name, { state: 'unknown' }])),
      },
    });
    throw error;
  }
  const statusResults = await Promise.allSettled(targets.map(async (target) => {
    const status = await inspectAndRepairSync({
      target,
      sourceDir,
      stackBaseDir,
      env,
      inspectSync,
      repairSync,
    });
    assertUsableStatus(target, status);
    return { target: target.name, status };
  }));
  const targetPreparation = Object.fromEntries(statusResults.map((result, index) => [
    targets[index].name,
    result.status === 'fulfilled'
      ? { state: 'ready' }
      : { state: 'failed', error: errorMessage(result.reason) },
  ]));
  const failedPreparation = statusResults.findIndex((result) => result.status === 'rejected');
  const updatedAt = new Date().toISOString();
  await writePreparationState({
    stackBaseDir,
    env,
    state: {
      version: 1,
      state: failedPreparation === -1 ? 'ready' : 'failed',
      startedAt,
      updatedAt,
      targets: targetPreparation,
    },
  });
  if (failedPreparation !== -1) throw statusResults[failedPreparation].reason;
  const statuses = statusResults.map((result) => result.value);
  const targetBySession = new Map(
    targets.map((target) => [resolveMutagenSessionName(target.name), target]),
  );
  const recoveryByTarget = new Map();
  const scheduleConflictRecovery = ({ sessionName, conflictCount }) => {
    if (!Number.isFinite(conflictCount) || conflictCount <= 0) return;
    const target = targetBySession.get(sessionName);
    if (!target) return;
    const prior = recoveryByTarget.get(target.name) ?? Promise.resolve();
    const recovery = prior
      .catch(() => null)
      .then(async () => {
        const status = await inspectSync({ target, stackBaseDir, env });
        const result = await repairSync({ target, status, sourceDir, stackBaseDir, env });
        if (result?.repaired) {
          process.stderr.write(
            `[dev-targets] ${target.name} removed stale ignored artifacts for deleted source ${result.roots.join(', ')}\n`,
          );
        }
      })
      .catch((error) => {
        process.stderr.write(
          `[dev-targets] ${target.name} synchronization conflict requires manual resolution: ${errorMessage(error)}\n`,
        );
      });
    recoveryByTarget.set(target.name, recovery);
  };
  const monitor = detached
    ? null
    : spawnMonitor({
        command: 'mutagen',
        args: buildMutagenMonitorArgs(
          targets.map((target) => resolveMutagenSessionName(target.name)),
        ),
        lineFilter: createMutagenMonitorLineFilter({ onStateChange: scheduleConflictRecovery }),
        env: project.env,
      });
  return { project, statuses, monitor };
}

export async function waitForDevTargetSyncMonitor(
  monitor,
  {
    signalSource = process,
    stopMonitor = async (child, signal) => await killProcessTree(child, signal),
  } = {},
) {
  let requestedSignal = null;
  let stopPromise = null;
  const requestStop = (signal) => {
    if (requestedSignal) return;
    requestedSignal = signal;
    stopPromise = Promise.resolve(stopMonitor(monitor, 'SIGTERM')).catch(() => null);
  };
  const onInterrupt = () => requestStop('SIGINT');
  const onTerminate = () => requestStop('SIGTERM');
  signalSource.once('SIGINT', onInterrupt);
  signalSource.once('SIGTERM', onTerminate);
  try {
    const completion = await monitor.completion;
    if (stopPromise) await stopPromise;
    if (requestedSignal) {
      return { code: requestedSignal === 'SIGINT' ? 130 : 143, signal: requestedSignal };
    }
    return completion;
  } finally {
    signalSource.removeListener('SIGINT', onInterrupt);
    signalSource.removeListener('SIGTERM', onTerminate);
  }
}

export async function stopDevTargetSyncService(
  { stackBaseDir, env = process.env },
  { releaseProject = releaseIndependentDevTargetSyncProject } = {},
) {
  return {
    released: await releaseProject({ stackBaseDir, env }),
  };
}

export async function inspectDevTargetSyncService(
  { stackBaseDir, targets, env = process.env },
  {
    readProject = async () => {
      const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
      return await readFile(runtime.projectFile, 'utf8').catch(() => null);
    },
    inspectSync = inspectDevTargetSync,
    readPreparationState = defaultReadPreparationState,
  } = {},
) {
  const project = await readProject();
  const preparation = await readPreparationState({ stackBaseDir, env });
  const statuses = await Promise.all(targets.map(async (target) => ({
    target: target.name,
    status: await inspectSync({ target, stackBaseDir, env }),
  })));
  return {
    independent: isMutagenProjectOwnedBy(project, INDEPENDENT_DEV_TARGET_SYNC_OWNER),
    preparation,
    statuses,
  };
}
