import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { killProcessTree, spawnProc } from '../proc/proc.mjs';
import { inspectDevTargetSync, prepareDevTargetSourceCommand, runDevTargetCommand } from './executor.mjs';
import {
  DEV_TARGET_DISPOSABLE_REPLICA_ARTIFACT_ROOTS,
  hasCurrentMutagenProjectTarget,
  resolveMutagenProjectTargets,
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
  flushDevTargetSync,
  INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  releaseIndependentDevTargetSyncProject,
  resumeDevTargetSync,
  runDevTargetControlProcess,
} from './sync_project.mjs';
import { startDevTargetRuntime } from './managed_runtime.mjs';
import { buildRemoteEnsureDirectoriesCommand } from './remote_commands.mjs';
import { resolveDevTargetExecutionPolicy } from './config.mjs';
import { resolveDevTargetServicePlans } from './service_placement.mjs';
import { measureReplicaSourceBytes } from './replica_source_bytes.mjs';

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

function assertUsableStatus(target, status) {
  if (status.state === 'ready' || status.state === 'synchronizing' || status.state === 'needs-flush') return;
  const detail = status.lastError || status.error;
  throw new Error(
    `[dev-targets] ${target.name} synchronization is ${status.state}`
      + (detail ? `: ${detail}` : ''),
  );
}

async function defaultEnsureReplicaRoots({ targets, stackBaseDir, env, commandReplica = false, sourceBytes, requireSourceAdmission = false, prepareExecutor }) {
  const results = await Promise.all(targets.map(async (target) => {
    const ensure = async (requiredAdditionalBytes) => await runDevTargetControlProcess({
      label: `remote:${target.name}`,
      command: 'ssh',
      args: [
        ...(target.sshConfigFile ? ['-F', target.sshConfigFile] : []),
        '-o',
        'BatchMode=yes',
        target.ssh,
        buildRemoteEnsureDirectoriesCommand(target, { commandReplica, requiredAdditionalBytes, requireSourceAdmission }),
      ],
      env,
    });
    let result = await ensure();
    const cold = result.out?.split(/\r?\n/).includes('__HAPPIER_COMMAND_REPLICA_UNMATERIALIZED__');
    if (result?.code === 0 && cold && sourceBytes) {
      // The admission owner lives in the primary executor mirror, not the
      // cold command replica. Refresh it through the existing causal barrier
      // before asking it to certify the measured-write ingress.
      if (prepareExecutor) await prepareExecutor(target);
      result = await ensure(await sourceBytes());
    }
    if (result?.code !== 0) {
      throw new Error(`[dev-targets] ${target.name} replica directory bootstrap failed`);
    }
    return result.out?.split(/\r?\n/).includes('__HAPPIER_COMMAND_REPLICA_UNMATERIALIZED__') ? target.name : null;
  }));
  return results.filter(Boolean);
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
          'if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then exit 0; fi',
          '[ -d "$candidate" ]',
          'candidate_name=${candidate##*/}',
          'found_marker=0',
          'for marker in "$@"; do',
          '  if [ "$candidate_name" = "$marker" ] || [ -e "$candidate/$marker" ] || [ -L "$candidate/$marker" ]; then',
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
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir, env });
  const sessionName = resolveMutagenSessionName(target.name, runtime.sourceDir);
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
  let status = await inspectSync({ target, stackBaseDir, env });
  // With both endpoints unwatched, Mutagen waits for a flush even for the
  // first scan. Seed it here so normal command admission can require a scan.
  if (status.state === 'needs-flush' || status.recovery === 'rescan') {
    await flushDevTargetSync({ target, env });
    status = await inspectSync({ target, stackBaseDir, env });
  }
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
    resumeSync = resumeDevTargetSync,
    spawnMonitor = defaultSpawnMonitor,
    repairSync = repairRecoverableDevTargetSyncConflicts,
    startTargetRuntime = startDevTargetRuntime,
    ensureReplicaRoots = defaultEnsureReplicaRoots,
    writePreparationState = defaultWritePreparationState,
  } = {},
) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('[dev-targets] no targets are configured for synchronization');
  }
  if (basename(stackBaseDir).startsWith('agent-qa')) {
    throw new Error('[dev-targets] QA stacks consume shared synchronization; start sync-service through the routing producer');
  }
  env = { ...env, HAPPIER_STACK_SYNC_SOURCE_DIR: sourceDir };
  const preparationResults = await Promise.allSettled(targets.map(async (target) => {
    await startTargetRuntime({ target, env });
    await ensureReplicaRoots({ targets: [target], stackBaseDir, env });
  }));
  const preparedTargets = targets.filter((_, index) => preparationResults[index].status === 'fulfilled');
  if (preparedTargets.length === 0) throw preparationResults[0].reason;
  const project = await ensureProject({
    stackBaseDir,
    sourceDir,
    targets: preparedTargets,
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
    allowIndependentBorrow: false,
    preserveExistingTargets: true,
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
  await Promise.allSettled(preparedTargets.map(async (target) => {
    await resumeSync({ target, env: project.env });
  }));
  const statusResults = await Promise.allSettled(targets.map(async (target, index) => {
    const preparation = preparationResults[index];
    if (preparation.status === 'rejected') throw preparation.reason;
    const status = await inspectAndRepairSync({
      target,
      sourceDir,
      stackBaseDir,
      env: project.env,
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
  if (statusResults.every((result) => result.status === 'rejected')) throw statusResults[failedPreparation].reason;
  const statuses = statusResults.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : {
        target: targets[index].name,
        status: {
          state: 'unhealthy',
          sessionName: resolveMutagenSessionName(targets[index].name, sourceDir),
          error: errorMessage(result.reason),
        },
      });
  const targetBySession = new Map(
    preparedTargets.map((target) => [resolveMutagenSessionName(target.name, sourceDir), target]),
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
          preparedTargets.map((target) => resolveMutagenSessionName(target.name, sourceDir)),
        ),
        lineFilter: createMutagenMonitorLineFilter({ onStateChange: scheduleConflictRecovery }),
        env: project.env,
      });
  return { project, statuses, monitor };
}

// Sibling checkouts are command replicas only. Provision through the existing
// project owner without a monitor or spontaneous source propagation. Seed new
// sessions once; every later command crosses the launcher's selected barrier.
export async function prepareDevTargetCommandSync({ stackBaseDir, sourceDir, targets, executorSourceDir, executorStackBaseDir, env = process.env }) {
  env = { ...env, HAPPIER_STACK_SYNC_SOURCE_DIR: sourceDir };
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
  const desired = await readFile(runtime.projectFile, 'utf8').catch(() => null);
  const config = JSON.parse(await readFile(join(stackBaseDir, 'dev-targets.json'), 'utf8'));
  const { renderMutagenProject, isEquivalentMutagenProject } = await import('./mutagen_project.mjs');
  const state = await defaultReadPreparationState({ stackBaseDir, env });
  // Unreachable replicas remain unavailable to ordinary AUTO selection; they
  // must not prevent a healthy sibling worker from becoming usable.
  const runtimeTargets = new Set(resolveDevTargetServicePlans({ targets: config.targets,
    policy: resolveDevTargetExecutionPolicy(config), requested: { server: true, expo: true, daemon: true },
  }).targets.filter(plan => Object.values(plan.services).some(Boolean)).map(plan => plan.target.name));
  let sourceMeasurement;
  const sourceBytes = () => sourceMeasurement ??= measureReplicaSourceBytes(sourceDir, env);
  const prepareExecutor = executorSourceDir && executorStackBaseDir
    ? target => prepareDevTargetSourceCommand({ target, sourceDir: executorSourceDir,
      stackBaseDir: executorStackBaseDir, flush: true, env }) : undefined;
  const roots = await Promise.allSettled(targets.map(target => defaultEnsureReplicaRoots({
    targets: [target], stackBaseDir, env, commandReplica: !runtimeTargets.has(target.name), sourceBytes,
    requireSourceAdmission: state?.targets?.[target.name]?.state !== 'ready' || !desired
      || !hasCurrentMutagenProjectTarget(desired, { sourceDir, target, config, ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER }),
    prepareExecutor,
  })));
  // Preparation failure excludes command placement, not an unchanged admitted
  // mirror. Keep its session reconnecting; only new destinations need admission.
  const reachable = targets.filter((_, index) => roots[index].status === 'fulfilled');
  const excludedTargets = targets.filter((_, index) => roots[index].status === 'rejected').map(target => target.name);
  roots.forEach(result => {
    if (result.status === 'rejected') process.stderr.write(`${errorMessage(result.reason)}\n`);
  });
  if (reachable.length === 0) {
    throw Object.assign(new AggregateError(roots.map(result => result.reason),
      `[dev-targets] DEV_TARGET_REPLICA_BOOTSTRAP_FAILED: no eligible replica target (${excludedTargets.join(', ')})`), {
      code: 'DEV_TARGET_REPLICA_BOOTSTRAP_FAILED', targets: excludedTargets,
    });
  }
  const projectTargets = resolveMutagenProjectTargets(desired, {
    sourceDir, targets: reachable, config, ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
  });
  const unchanged = desired && isEquivalentMutagenProject(desired, renderMutagenProject({ sourceDir, targets: projectTargets, config }));
  const unmaterialized = new Set(roots.flatMap(result => result.status === 'fulfilled' ? result.value : []));
  if (unchanged && reachable.length === targets.length && unmaterialized.size === 0
    && targets.every(target => state?.targets?.[target.name]?.state === 'ready')) return { excludedTargets };
  const project = await ensureDevTargetSyncProject({
    stackBaseDir, sourceDir, targets: reachable, preserveExistingTargets: true,
    ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
    allowIndependentBorrow: false, env,
  });
  const pending = targets.filter((target, index) => !unchanged || state?.targets?.[target.name]?.state !== 'ready'
    || roots[index].status === 'rejected' || unmaterialized.has(target.name));
  const results = await Promise.allSettled(pending.map(async target => {
    const root = roots[targets.indexOf(target)];
    if (root.status === 'rejected') throw root.reason;
    await resumeDevTargetSync({ target, env: project.env });
    if (unmaterialized.has(target.name)) {
      const reset = await runDevTargetControlProcess({ label: `sync:${target.name}`, command: 'mutagen',
        args: ['sync', 'reset', resolveMutagenSessionName(target.name, sourceDir)], env: project.env });
      if (reset.code !== 0) throw new Error(`[dev-targets] ${target.name} synchronization reset failed for retired command replica`);
    }
    await flushDevTargetSync({ target, env: project.env });
  }));
  const prepared = { ...(unchanged ? state?.targets : {}) };
  results.forEach((result, index) => {
    prepared[pending[index].name] = result.status === 'fulfilled' ? { state: 'ready' } : { state: 'failed', error: errorMessage(result.reason) };
  });
  await defaultWritePreparationState({ stackBaseDir, env, state: {
    version: 1, state: results.every(result => result.status === 'fulfilled') ? 'ready' : 'failed', targets: prepared,
  } });
  return { excludedTargets };
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
  if (basename(stackBaseDir).startsWith('agent-qa')) {
    throw new Error('[dev-targets] QA stacks cannot stop the shared routing-owned synchronization');
  }
  return {
    released: await releaseProject({ stackBaseDir, env }),
  };
}

export async function inspectDevTargetSyncService(
  { stackBaseDir, sourceDir, targets, env = process.env },
  {
    readProject = async () => {
      const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir, env });
      return await readFile(runtime.projectFile, 'utf8').catch(() => null);
    },
    inspectSync = inspectDevTargetSync,
    readPreparationState = defaultReadPreparationState,
  } = {},
) {
  const project = await readProject();
  if (sourceDir) env = { ...env, HAPPIER_STACK_SYNC_SOURCE_DIR: sourceDir };
  const preparation = await readPreparationState({ stackBaseDir, env });
  const statuses = await Promise.all(targets.map(async (target) => ({
    target: target.name,
    status: await inspectSync({ target, stackBaseDir, env }),
  })));
  const independent = isMutagenProjectOwnedBy(project, INDEPENDENT_DEV_TARGET_SYNC_OWNER);
  return {
    independent,
    state: independent && statuses.length > 0
      && statuses.every(({ status }) => status.state === 'ready' || status.state === 'synchronizing' || status.state === 'needs-flush')
      ? 'ready' : 'failed',
    preparation,
    statuses,
  };
}
