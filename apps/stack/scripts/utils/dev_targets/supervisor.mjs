import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls';
import { packControlledRuntimeSnapshot, transferRuntimeFile, removeRemoteRuntimeTransferArchives } from './runtime_artifact_transfer.mjs';
import { ensureRemoteServerDataReady } from './retained_server_data.mjs';
import { isAuthFlowEnabled } from '../auth/daemon_gate.mjs';
import { findExistingStackCredentialPath } from '../auth/credentials_paths.mjs';

import { killProcessTree, spawnProc } from '../proc/proc.mjs';
import { resolveMutagenSessionName } from './mutagen_project.mjs';
import {
  buildMutagenMonitorArgs,
  createMutagenMonitorLineFilter,
} from './mutagen_monitor.mjs';
import {
  ensureDevTargetSyncProject,
  flushDevTargetSync,
  runDevTargetControlProcess,
} from './sync_project.mjs';
import { inspectDevTargetSync, runDevTargetCommand, runDevTargetDependencyBootstrap } from './executor.mjs';
import { startDevTargetRuntime } from './managed_runtime.mjs';
import { retireStackDevTarget } from './retirement.mjs';
import { waitForExpoMetroRunning } from '../expo/expo.mjs';
import { waitForServerReady as waitForHappierServerReady } from '../server/server.mjs';
import {
  buildRemoteStackCommand,
  buildRemoteDaemonReadinessProbeCommand,
  buildRemoteEnsureDirectoriesCommand,
  buildRemoteForwardProbeCommand,
  buildRemoteInstallCredentialCommand,
  buildRemoteRuntimeSnapshotImportCommand,
  buildRemoteRuntimeSnapshotProbeCommand,
  buildRemoteStackRetirementProbeCommand,
  resolveRemoteStackStatePaths,
  buildSshForwardArgs,
  buildSshWorkerArgs,
} from './remote_commands.mjs';

const TARGET_SYNC_READY = Symbol('TARGET_SYNC_READY');
const READINESS_RETRY_INTERVAL_MS = 5_000;

export function resolveRemoteServerReadyTimeoutMs(env = process.env) {
  const configured = Number.parseInt(String(env.HAPPIER_STACK_SERVER_READY_TIMEOUT_MS ?? ''), 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : Infinity;
}

function planRunsRuntimeServices(plan) {
  return Object.values(plan?.services ?? {}).some(Boolean);
}

export function planRequiresRemoteCliWorkspacePreparation(plan) {
  return plan?.services?.daemon === true;
}

function planDefersRemoteCompanionPreparation(plan) {
  return plan?.services?.server === true && planRequiresRemoteCliWorkspacePreparation(plan);
}

export function resolveDefaultRemoteServerPort({
  localServerPort,
  targetIndex,
  instanceId = process.pid,
} = {}) {
  const local = Math.abs(Math.trunc(Number(localServerPort) || 0));
  const instance = Math.abs(Math.trunc(Number(instanceId) || 0));
  const index = Math.abs(Math.trunc(Number(targetIndex) || 0));
  return 40_000 + ((local + instance + (index * 997)) % 20_000);
}

export function resolveDefaultRemoteExpoPort({ localExpoPort, targetIndex, instanceId = process.pid } = {}) {
  const local = Math.abs(Math.trunc(Number(localExpoPort) || 0));
  const instance = Math.abs(Math.trunc(Number(instanceId) || 0));
  const index = Math.abs(Math.trunc(Number(targetIndex) || 0));
  return 20_000 + ((local + instance + (index * 577)) % 20_000);
}

function resolveCanonicalLoopbackForward(canonicalServerUrl, localServerPort) {
  if (!canonicalServerUrl) return null;
  const url = new URL(canonicalServerUrl);
  if (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname)) return null;
  const hostname = url.hostname.replace(/\.$/u, '');
  return {
    direction: 'reverse',
    listenHost: hostname === 'localhost' || hostname.endsWith('.localhost') ? '127.0.0.1' : hostname,
    listenPort: Number(url.port || 80),
    targetHost: '127.0.0.1',
    targetPort: localServerPort,
  };
}

function defaultSpawnProcess({
  label,
  command,
  args,
  env,
  silent = false,
  persistOutput = true,
  lineFilter,
}) {
  return spawnProc(label, command, args, env, { silent, persistOutput, lineFilter });
}

async function defaultStopProcess(child) {
  if (!child || child.exitCode != null) return;
  await killProcessTree(child, 'SIGINT', { graceMs: 2_000 });
}

async function defaultWaitForProcess(child) {
  if (child?.completion) return await child.completion;
  return await new Promise(() => {});
}

function resolveRetryDelayMs(attempt) {
  return Math.min(60_000, 5_000 * (2 ** Math.max(0, attempt - 1)));
}

async function defaultWaitForRetry({ delayMs }) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function resolveExpoReadinessTimeoutMs(env = process.env) {
  const configured = Number(env.HAPPIER_DEV_TARGET_EXPO_READY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : Infinity;
}

async function defaultWaitForExpoReady({ port, env = process.env, signal } = {}) {
  const timeoutMs = resolveExpoReadinessTimeoutMs(env);
  const result = await waitForExpoMetroRunning({
    port,
    timeoutMs,
    intervalMs: 500,
    env,
    signal,
    // Only an explicitly configured operator deadline ends readiness;
    // otherwise the supervisor's process/cancellation lifetime owns it.
    continueOnTimeout: false,
  });
  if (result.ok) return;
  if (result.reason === 'aborted' || signal?.aborted) {
    throw signal.reason ?? new Error('remote Expo readiness was cancelled');
  }
  throw new Error(`timed out waiting for tunneled Expo on localhost:${String(port)} after ${timeoutMs}ms`);
}

async function defaultWaitForServerReady({ url, env = process.env, signal } = {}) {
  const timeoutMs = resolveRemoteServerReadyTimeoutMs(env);
  await waitForHappierServerReady(url, {
    timeoutMs,
    intervalMs: 500,
    signal,
  });
}

function resolveDaemonReadinessTimeoutMs(env = process.env) {
  const configured = Number(env.HAPPIER_DEV_TARGET_DAEMON_READY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : Infinity;
}

async function waitForAbortableDelay(delayMs, signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('remote daemon readiness was cancelled');
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('remote daemon readiness was cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer.unref?.();
  });
}

async function defaultWaitForDaemonReady({
  target,
  stackName,
  sshArgs,
  runProcess,
  env = process.env,
  signal,
  runtimeMode = 'source',
} = {}) {
  const timeoutMs = resolveDaemonReadinessTimeoutMs(env);
  const startedAt = Date.now();
  const command = buildRemoteDaemonReadinessProbeCommand(target, { stackName, runtimeMode });
  while (!signal?.aborted && Date.now() - startedAt < timeoutMs) {
    const result = await runProcess({
      label: `remote:${target.name}`,
      command: 'ssh',
      args: [
        ...sshArgs,
        '-o',
        'BatchMode=yes',
        target.ssh,
        command,
      ],
      env,
    });
    if (result?.code === 0) return;
    await waitForAbortableDelay(READINESS_RETRY_INTERVAL_MS, signal);
  }
  if (signal?.aborted) {
    throw signal.reason ?? new Error('remote daemon readiness was cancelled');
  }
  throw new Error(
    `timed out waiting for ${target.name} daemon readiness after ${timeoutMs}ms`,
  );
}

function requireSuccessful(result, description) {
  if (result?.code === 0) return;
  if (result?.error?.code === 'ENOENT') {
    throw new Error(
      `[dev-targets] ${description} failed because Mutagen was not found.\n` +
        'Install Mutagen locally and ensure `mutagen` is available on PATH, or remove this stack’s dev-targets.json.',
    );
  }
  const error = new Error(`[dev-targets] ${description} failed (code=${String(result?.code ?? 'unknown')})`);
  error.commandExitCode = result?.code;
  if (result?.error?.code === 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED') {
    error.code = result.error.code;
    error.message += `\n${result.error.message}`;
  }
  throw error;
}

function remoteCredentialPaths(target, stackName, runtimeMode = 'source') {
  const { activeServerId, cliHomeDir: base } = resolveRemoteStackStatePaths(target, { stackName, runtimeMode });
  const stagedPath = `${base}/.access-key-${stackName}.tmp`;
  const finalPath = `${base}/servers/${activeServerId}/access.key`;
  return { stagedPath, finalPath };
}

export async function startStackDevTargets(
  {
    stackName,
    stackBaseDir,
    syncStackBaseDir = stackBaseDir,
    sourceDir,
    localServerPort,
    localExpoPort = null,
    publicServerUrl = '',
    canonicalServerUrl = '',
    expoPublicUrl = '',
    resolveMobilePublicUrlsOnTarget = false,
    expoListenHost = '127.0.0.1',
    startMobile = false,
    activeServerId,
    credentialPath,
    cliHomeDir,
    remoteServerRuntimeConfig = null,
    remoteWorkspacePreparation = null,
    runtimeSnapshot = null,
    sourceSnapshot = false,
    sourceUi = 'export',
    runtimeTarget = null,
    borrowedExpoProducerStackName = '',
    targets,
    syncTargets = null,
    targetPlans = null,
    onTargetStateChange = null,
    onServerDataAuthority = null,
    env = process.env,
    instanceId = process.pid,
  },
  {
    runProcess = runDevTargetControlProcess,
    spawnProcess = defaultSpawnProcess,
    stopProcess = defaultStopProcess,
    waitForProcess = defaultWaitForProcess,
    waitForRetry = defaultWaitForRetry,
    waitForServerReady = defaultWaitForServerReady,
    waitForExpoReady = defaultWaitForExpoReady,
    waitForDaemonReady = defaultWaitForDaemonReady,
    runDependencyBootstrap = runDevTargetDependencyBootstrap,
    inspectSync = inspectDevTargetSync,
    flushSync = flushDevTargetSync,
    startManagedRuntime = startDevTargetRuntime,
    logger = console,
    transferFile = transferRuntimeFile,
    runCommand = runDevTargetCommand,
  } = {},
) {
  const plans = Array.isArray(targetPlans)
    ? targetPlans
    : (Array.isArray(targets) ? targets : []).map((target) => ({
      target,
      services: { server: false, expo: false, daemon: true },
    }));
  if (plans.length === 0) {
    return { workers: [], close: async () => {} };
  }
  const configuredTargets = Array.isArray(syncTargets)
    ? syncTargets
    : plans.map((plan) => plan.target);
  const servicePlans = plans.filter(planRunsRuntimeServices);
  const resolvePlanRuntime = plan => ({
    snapshot: plan.runtimeSnapshot ?? runtimeSnapshot,
    target: plan.runtimeTarget ?? runtimeTarget,
  });
  const controlled = Boolean(runtimeSnapshot || servicePlans.some(plan => plan.runtimeSnapshot));
  if (sourceSnapshot && controlled) throw new Error('[dev-targets] source snapshots cannot select native runtime snapshots');
  if (sourceSnapshot && servicePlans.some(plan => plan.services.expo)) {
    throw new Error('[dev-targets] source snapshot services cannot own a watching Expo process');
  }
  const retainedRuntime = controlled || sourceSnapshot;
  const runtimeMode = sourceSnapshot ? 'source-snapshot' : controlled ? 'controlled' : 'source';
  const canonicalLoopbackForward = resolveCanonicalLoopbackForward(canonicalServerUrl, localServerPort);
  if (controlled && servicePlans.some(plan => {
    const selected = resolvePlanRuntime(plan);
    return !selected.snapshot || !selected.target?.platform || !selected.target?.arch
      || (!plan.services.server && !plan.services.daemon) || plan.services.expo;
  })) {
    throw new Error('[dev-targets] controlled runtime requires a selected snapshot and target identity for each server/daemon plan without owned Expo');
  }
  // When this supervisor owns runtime services, only their synchronization may
  // gate service startup. Command-only targets are routed and freshness-checked
  // by the command executor; an unrelated target must not keep Expo/daemon down.
  // Preserve the original command-only behavior when no runtime service exists.
  const requiredSyncPlans = servicePlans.length > 0 ? servicePlans : plans;
  if (plans.some((plan) => plan.services.daemon) && !credentialPath && !isAuthFlowEnabled(env)) {
    throw new Error(
      '[dev-targets] the local stack has no daemon credential to seed remotely; authenticate the local daemon first',
    );
  }

  const infraEnv = {
    ...env,
    HAPPIER_STACK_SYNC_SOURCE_DIR: sourceDir,
    HAPPIER_STACK_PROCESS_KIND: 'infra',
    HAPPIER_STACK_LOG_TEE_DIR:
      String(env.HAPPIER_STACK_LOG_TEE_DIR ?? '').trim() || join(stackBaseDir, 'logs'),
    HAPPIER_STACK_LOG_TEE_TIMESTAMPS:
      String(env.HAPPIER_STACK_LOG_TEE_TIMESTAMPS ?? '').trim() || '1',
  };
  const workersByTarget = new Map();
  const remoteStackOptionsByTarget = new Map();
  const startedRemoteTargets = new Set();
  const tunnelsByTarget = new Map();
  const servicePortsByTarget = new Map();
  const sourceRuntimeObservationsByTarget = new Map();
  const targetFailuresByTarget = new Map();
  const provisionedTargets = new Set();
  const deferredCompanionPreparationsByTarget = new Map();
  const credentialPreparationsByTarget = new Map();
  const lifecycleTasks = [];
  const startupStartedAt = Date.now();
  const phaseTimingsByTarget = new Map();
  let monitorWorker = null;
  let syncProject = null;
  let closed = false;
  let resolveCloseRequested;
  const closeRequested = new Promise((resolve) => {
    resolveCloseRequested = resolve;
  });
  const publishTargetState = (plan, status, details = {}) => {
    if (sourceSnapshot) {
      const nextPhase = status === 'running' ? 'running' : details.phase;
      const previous = phaseTimingsByTarget.get(plan.target.name);
      if (nextPhase && previous?.phase !== nextPhase) {
        const now = Date.now();
        if (previous) logger.info?.(`[dev-targets] ${plan.target.name} phase=${previous.phase} elapsedMs=${now - previous.startedAt} startupElapsedMs=${now - startupStartedAt} nextPhase=${nextPhase} status=${status}`);
        phaseTimingsByTarget.set(plan.target.name, { phase: nextPhase, startedAt: now });
      }
    }
    if (typeof onTargetStateChange !== 'function') return;
    const forward = tunnelsByTarget.get(plan.target.name);
    const servicePorts = servicePortsByTarget.get(plan.target.name);
    const publishesServicePorts = servicePorts && Object.keys(servicePorts).length > 0;
    const serviceStatus = Object.fromEntries(
      Object.entries(plan.services)
        .filter(([, enabled]) => enabled === true)
        .map(([service]) => [service, details.serviceStatus?.[service] ?? status]),
    );
    const state = {
      name: plan.target.name,
      commands: plan.commands === true,
      services: { ...plan.services },
      runtimeMode,
      forwardPid: forward && forward.exitCode == null && forward.signalCode == null ? forward.pid ?? null : null,
      ...(publishesServicePorts ? { repoDir: plan.target.repoDir, servicePorts } : {}),
      serviceStatus,
      status,
      ...(status === 'running' ? { phase: null, error: null } : {}),
      ...(controlled && (serviceStatus.server === 'running' || serviceStatus.daemon === 'running')
        ? { runtimeSnapshotId: resolvePlanRuntime(plan).snapshot.snapshotId } : {}),
      ...(sourceSnapshot && sourceRuntimeObservationsByTarget.has(plan.target.name)
        ? sourceRuntimeObservationsByTarget.get(plan.target.name) : {}),
      ...details,
    };
    try {
      const pending = onTargetStateChange(state);
      return pending?.catch?.((error) => {
        logger.error?.(
          `[dev-targets] ${plan.target.name} runtime state projection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    } catch (error) {
      logger.error?.(
        `[dev-targets] ${plan.target.name} runtime state projection failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  try {
    syncProject = await ensureDevTargetSyncProject({
      stackBaseDir: syncStackBaseDir,
      sourceDir,
      targets: configuredTargets,
      requiredTargets: requiredSyncPlans.map((plan) => plan.target),
      ownerId: instanceId,
      allowIndependentBorrow: true,
      borrowOnly: retainedRuntime,
      env: infraEnv,
    }, { runProcess });
    if (sourceSnapshot) logger.info?.(`[dev-targets] synchronization admission elapsedMs=${Date.now() - startupStartedAt}`);
    const { projectFile } = syncProject;
    // Lifecycle bootstrap, readiness and workers must remain reachable when
    // synchronization or jobs saturate the shared SSH master. Keep Mutagen's
    // transport unchanged; the supervisor owns these independent connections.
    const openSsh = {
      ...syncProject.openSsh,
      sshArgs: ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', ...syncProject.openSsh.sshArgs],
    };
    const retireRemoteTarget = (target, options, { probeBeforeStop = true } = {}) => retireStackDevTarget({
      target, options, sshArgs: openSsh.sshArgs, env: infraEnv, probeBeforeStop,
    }, { runProcess, logger });
    const mutagenEnv = syncProject.env;
    const mutagenMonitorEnv = {
      ...mutagenEnv,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    };
    monitorWorker = spawnProcess({
      label: 'mutagen',
      command: 'mutagen',
      args: buildMutagenMonitorArgs(
        configuredTargets.map((target) => resolveMutagenSessionName(target.name, sourceDir)),
      ),
      lineFilter: createMutagenMonitorLineFilter(),
      env: mutagenMonitorEnv,
    });

    const verifyLoadedRuntimeIdentity = async (plan, component) => {
      if (!retainedRuntime) return;
      const { target, services } = plan;
      const result = await runProcess({
        label: `remote:${target.name}`, command: 'ssh', args: [
          ...openSsh.sshArgs, '-o', 'BatchMode=yes', target.ssh,
          buildRemoteRuntimeSnapshotProbeCommand(target, {
            stackName, runtimeMode, sourceUi, snapshotId: resolvePlanRuntime(plan).snapshot?.snapshotId,
            services: sourceSnapshot && component ? { [component]: true } : services,
          }),
        ], env: infraEnv,
      });
      requireSuccessful(result, `${target.name} loaded runtime identity`);
      if (sourceSnapshot) {
        const observed = JSON.parse(result.out);
        if (!observed.sourceRuntimeIdentities || typeof observed.sourceRuntimeIdentities !== 'object'
          || (component && !observed.sourceRuntimeIdentities[component])) {
          throw new Error(`[dev-targets] ${target.name} source runtime identity observation is missing`);
        }
        const previous = sourceRuntimeObservationsByTarget.get(target.name);
        for (const [observedComponent, identity] of Object.entries(observed.sourceRuntimeIdentities)) {
          const selected = previous?.sourceRuntimeIdentities?.[observedComponent]?.selected;
          if (selected && identity.selected !== selected) {
            throw new Error(`[dev-targets] ${target.name} recovered ${observedComponent} changed its selected source runtime`);
          }
        }
        sourceRuntimeObservationsByTarget.set(target.name, {
          ...previous, ...observed,
          sourceRuntimeIdentities: { ...previous?.sourceRuntimeIdentities, ...observed.sourceRuntimeIdentities },
        });
      }
    };

    const startTarget = async (plan, index, existingTunnel = null) => {
      const { target, services } = plan;
      const { snapshot: selectedSnapshot, target: selectedRuntimeTarget } = resolvePlanRuntime(plan);
      const hasServices = Object.values(services).some(Boolean);
      const deferCompanionPreparation = !retainedRuntime && planDefersRemoteCompanionPreparation(plan);
      let retainedSourceRuntime = sourceSnapshot ? sourceRuntimeObservationsByTarget.get(target.name) : null;
      let phase = 'prepare';
      let tunnel = existingTunnel;
      let createdTunnel = false;
      let credentialSeedTask = null;
      let credentialSeeded = false;
      let workspacePreparationCurrent = false;
      let retainedRemoteData = false;
      let serverAuthorityPinned = false;
      const pinServerDataAuthority = async () => {
        if (serverAuthorityPinned || !retainedRuntime || !services.server) return;
        if (typeof onServerDataAuthority === 'function') await onServerDataAuthority({ targetName: target.name });
        serverAuthorityPinned = true;
      };
      deferredCompanionPreparationsByTarget.delete(target.name);
      const beginPhase = (nextPhase) => {
        phase = nextPhase;
        publishTargetState(plan, 'starting', { phase });
      };
      const seedRemoteCredential = async () => {
        if (!services.daemon || credentialSeeded) return true;
        const currentCredentialPath = credentialPath || (cliHomeDir
          ? findExistingStackCredentialPath({ cliHomeDir, serverUrl: `http://127.0.0.1:${localServerPort}`, env })
          : null);
        if (!currentCredentialPath) return false;
        beginPhase('credentials');
        const { stagedPath, finalPath } = remoteCredentialPaths(target, stackName, runtimeMode);
        requireSuccessful(
          await runProcess({
            label: `remote:${target.name}`,
            command: 'scp',
            args: [
              '-q',
              ...openSsh.sshArgs,
              '-o',
              'BatchMode=yes',
              currentCredentialPath,
              `${target.ssh}:${stagedPath}`,
            ],
            env: infraEnv,
          }),
          `${target.name} credential transfer`,
        );
        requireSuccessful(
          await runProcess({
            label: `remote:${target.name}`,
            command: 'ssh',
            args: [
              '-o',
              'BatchMode=yes',
              ...openSsh.sshArgs,
              target.ssh,
              buildRemoteInstallCredentialCommand(target, { stagedPath, finalPath }),
            ],
            env: infraEnv,
          }),
          `${target.name} credential installation`,
        );
        credentialSeeded = true;
        return true;
      };
      const beginCredentialSeed = () => {
        if (!credentialSeedTask) {
          credentialSeedTask = seedRemoteCredential().then((seeded) => {
            if (!seeded) credentialSeedTask = null;
            return seeded;
          });
          // Deferred targets intentionally seed credentials before server
          // readiness. Their lifecycle awaits and reports this same task once
          // companion preparation is admitted, so suppress only an early
          // unhandled-rejection report here.
          void credentialSeedTask.catch(() => {});
        }
        return credentialSeedTask;
      };
      credentialPreparationsByTarget.set(target.name, async (signal) => {
        while (!credentialSeeded && !closed) {
          if (signal?.aborted) throw signal.reason;
          try {
            if (await beginCredentialSeed()) return;
          } catch (error) {
            credentialSeedTask = null;
            throw error;
          }
          await waitForAbortableDelay(READINESS_RETRY_INTERVAL_MS, signal);
        }
      });
      const prepareRemoteServices = async () => {
        await beginCredentialSeed();
        beginPhase('bootstrap');
        if (retainedRuntime) {
          await flushSync({ target, env: mutagenEnv }, { runProcess });
          if (services.server) {
            const readiness = await ensureRemoteServerDataReady({ target, stackName, stackBaseDir, syncStackBaseDir, env: infraEnv }, { runCommand });
            retainedRemoteData = readiness?.retainedRemoteData === true;
            if (retainedRemoteData) await pinServerDataAuthority();
          }
          if (sourceSnapshot) {
            provisionedTargets.add(target.name);
            return;
          }
          const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode });
          const remoteArchive = `${paths.stackBaseDir}/.runtime-${selectedSnapshot.snapshotId}.tar`;
          const temporary = await mkdtemp(join(tmpdir(), 'hstack-controlled-runtime-'));
          try {
            const archivePath = join(temporary, 'snapshot.tar');
            await packControlledRuntimeSnapshot({ snapshot: selectedSnapshot, target: selectedRuntimeTarget, archivePath, env: infraEnv });
            await transferFile({ target, direction: 'upload', localPath: archivePath, remotePath: remoteArchive });
            requireSuccessful(await runProcess({ label: `remote:${target.name}`, command: 'ssh', args: [
              ...openSsh.sshArgs, '-o', 'BatchMode=yes', target.ssh,
              buildRemoteRuntimeSnapshotImportCommand(target, { stackName, archivePath: remoteArchive, snapshotId: selectedSnapshot.snapshotId,
                requiredComponents: services.server ? (services.daemon ? undefined : ['server']) : ['daemon'] }),
            ], env: infraEnv }), `${target.name} controlled runtime import`);
          } finally {
            try {
              await rm(temporary, { recursive: true, force: true });
            } finally {
              try {
                await removeRemoteRuntimeTransferArchives({ archivePaths: [remoteArchive],
                  runCommand: commandArgs => runCommand({ target, stackBaseDir, commandArgs,
                    syncAlreadyVerified: true, dependencyAdmission: 'skip', workspacePreparation: 'skip',
                    provenance: 'skip', env: infraEnv }),
                });
              } catch (error) {
                logger.error?.(`[dev-targets] ${target.name} transfer archive cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
          provisionedTargets.add(target.name);
          return;
        }
        if (
          !workspacePreparationCurrent
          && planRequiresRemoteCliWorkspacePreparation(plan)
          && remoteWorkspacePreparation
        ) {
          await (typeof remoteWorkspacePreparation === 'function'
            ? remoteWorkspacePreparation()
            : remoteWorkspacePreparation);
          workspacePreparationCurrent = true;
        }
        requireSuccessful(
          await runDependencyBootstrap({
            target,
            stackBaseDir,
            // Local generated inputs are published immediately before the
            // supervisor starts. Use the existing explicit Mutagen barrier
            // once before executing component bootstrap on the replica.
            syncAlreadyVerified: false,
            flush: true,
            env: infraEnv,
          }),
          `${target.name} dependency bootstrap`,
        );
        provisionedTargets.add(target.name);
      };
      try {
        beginPhase('prepare');
        if (syncProject.unhealthyTargets?.has(target.name)) {
          beginPhase('sync');
          const syncStatus = await inspectSync({ target, stackBaseDir: syncStackBaseDir, env: infraEnv });
          if (syncStatus.state !== 'ready' && syncStatus.state !== 'synchronizing' && syncStatus.state !== 'needs-flush') {
            throw new Error(
              `[dev-targets] ${target.name} independent synchronization is ${syncStatus.state}`,
            );
          }
          syncProject.unhealthyTargets.delete(target.name);
        }
        if (!provisionedTargets.has(target.name)) {
          if (target.managedRuntime || target.limaInstance) {
            await startManagedRuntime({ target, env: infraEnv });
          }
          requireSuccessful(
            await runProcess({
              label: `remote:${target.name}`,
              command: 'ssh',
              args: [
                ...openSsh.sshArgs,
                '-o',
                'BatchMode=yes',
                target.ssh,
                buildRemoteEnsureDirectoriesCommand(target, { stackName, runtimeMode }),
              ],
              env: infraEnv,
            }),
            `${target.name} directory bootstrap`,
          );
          beginPhase('sync');
          if (deferCompanionPreparation && services.daemon) {
            beginCredentialSeed();
          }
          if (deferCompanionPreparation && remoteWorkspacePreparation) {
            beginPhase('bootstrap');
            try {
              await (typeof remoteWorkspacePreparation === 'function'
                ? remoteWorkspacePreparation()
                : remoteWorkspacePreparation);
              await flushSync({ target, env: mutagenEnv }, { runProcess });
              workspacePreparationCurrent = true;
            } catch (error) {
              logger.warn?.(
                `[dev-targets] ${target.name} current workspace publication did not complete before worker launch; `
                  + `starting from last-green bytes while companion preparation retries: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
              );
            }
          }
          if (retainedRuntime && hasServices && !deferCompanionPreparation) {
            await prepareRemoteServices();
          }
        }

        if (closed) return null;
        if (!hasServices) {
          targetFailuresByTarget.delete(target.name);
          publishTargetState(plan, 'running');
          return TARGET_SYNC_READY;
        }
        const remoteServerPort =
          target.remoteServerPort ?? resolveDefaultRemoteServerPort({
            localServerPort,
            targetIndex: index,
            instanceId,
          });
        const remoteExpoPort = services.expo
          ? resolveDefaultRemoteExpoPort({ localExpoPort, targetIndex: index, instanceId })
          : null;
        servicePortsByTarget.set(target.name, {
          ...(services.server ? { server: remoteServerPort } : {}),
          ...(services.expo ? { expo: remoteExpoPort } : {}),
        });
        const forwards = [];
        if (services.server) {
          forwards.push({
            direction: 'local',
            listenHost: '127.0.0.1',
            listenPort: localServerPort,
            targetHost: '127.0.0.1',
            targetPort: remoteServerPort,
          });
        } else if (services.daemon || services.expo) {
          forwards.push({
            direction: 'reverse',
            listenHost: '127.0.0.1',
            listenPort: remoteServerPort,
            targetHost: '127.0.0.1',
            targetPort: localServerPort,
          });
        }
        // The private server port is not a substitute for the descriptor's
        // canonical Home endpoint. Keep that loopback origin reachable without
        // changing the daemon's identity verification or authentication audience.
        if (canonicalLoopbackForward && (services.daemon || services.expo)
          && !(services.server && canonicalLoopbackForward.listenHost === '127.0.0.1'
            && canonicalLoopbackForward.listenPort === remoteServerPort)
          && !forwards.some(forward => forward.direction === 'reverse'
            && forward.listenHost === canonicalLoopbackForward.listenHost
            && forward.listenPort === canonicalLoopbackForward.listenPort)) {
          forwards.push(canonicalLoopbackForward);
        }
        if (services.expo) {
          forwards.push({
            direction: 'local',
            listenHost: expoListenHost,
            listenPort: localExpoPort,
            targetHost: 'localhost',
            targetPort: remoteExpoPort,
          });
        }
        if (sourceSnapshot && !retainedSourceRuntime && startedRemoteTargets.has(target.name)) {
          // A failed launch may never have published runtime state. Only
          // verified absence permits a fresh start; otherwise recover the
          // loaded identity before retirement so SSH loss cannot rebundle it.
          beginPhase('runtime-identity');
          const absence = await runProcess({
            label: `remote:${target.name}`, command: 'ssh', args: [
              ...openSsh.sshArgs, '-o', 'BatchMode=yes', target.ssh,
              buildRemoteStackRetirementProbeCommand(target, { stackName, runtimeMode }),
            ], env: infraEnv,
          });
          if (absence?.code !== 0) {
            await verifyLoadedRuntimeIdentity(plan);
            retainedSourceRuntime = sourceRuntimeObservationsByTarget.get(target.name);
          }
        }
        const remoteStackOptions = {
          runtimeMode,
          reuseSourceRuntime: Boolean(retainedSourceRuntime),
          sourceUiLaunch: retainedSourceRuntime?.sourceUiLaunch,
          runtimeSnapshotId: selectedSnapshot?.snapshotId,
          borrowedExpoProducerStackName,
          sourceUi,
          services,
          attended: env.HAPPIER_STACK_TUI === '1',
          deferDaemonStartUntilCredentials: services.daemon && (deferCompanionPreparation || !credentialPath),
          serverUrl: `http://127.0.0.1:${remoteServerPort}`,
          publicServerUrl,
          canonicalServerUrl,
          activeServerId,
          stackName,
          remoteServerPort,
          remoteExpoPort,
          expoPublicPort: localExpoPort,
          remoteServerRuntimeConfig,
          expoPublicUrl,
          resolveServerPublicUrlOnTarget: Boolean(resolveMobilePublicUrlsOnTarget && services.server),
          resolveExpoPublicUrlOnTarget: Boolean(resolveMobilePublicUrlsOnTarget && services.expo),
          startMobile,
        };
        remoteStackOptionsByTarget.set(target.name, remoteStackOptions);
        beginPhase('stop');
        // A dropped SSH worker is not evidence that its detached daemon died.
        // Recovery replaces only the runner through Stack's existing
        // preserve-daemon restart owner; explicit starts/stops still retire all.
        if (!retainedSourceRuntime) await retireRemoteTarget(target, remoteStackOptions);
        // Retire recorded source consumers before bootstrap can rewrite the
        // shared dependency tree. Legacy Expo state can outlive runtime state.
        if (!retainedRuntime && !provisionedTargets.has(target.name) && !deferCompanionPreparation) {
          await prepareRemoteServices();
        }
        if (closed) return null;
        const remoteCommand = buildRemoteStackCommand(target, remoteStackOptions);
        beginPhase('tunnel');
        // A worker-only failure keeps a healthy forward, but that forward can
        // die while retirement/backoff is pending. Recheck at dispatch.
        if (tunnel && (tunnel.exitCode != null || tunnel.signalCode != null)) {
          if (tunnelsByTarget.get(target.name) === tunnel) tunnelsByTarget.delete(target.name);
          tunnel = null;
        }
        if (!tunnel) {
          tunnel = spawnProcess({
            label: `remote:${target.name}`,
            command: 'ssh',
            args: buildSshForwardArgs(target, {
              forwards,
              sshArgs: openSsh.sshArgs,
            }),
            env: infraEnv,
            // The readiness probe intentionally reaches this tunnel before the
            // remote Expo listener exists. Keep those expected SSH channel
            // refusals out of the target pane; lifecycle failures remain
            // visible through the supervisor's status/error projection.
            silent: true,
            persistOutput: false,
          });
          createdTunnel = true;
          tunnelsByTarget.set(target.name, tunnel);
        }
        if (!services.server) {
          const readinessDeadline = Date.now() + resolveRemoteServerReadyTimeoutMs(env);
          let readinessAttempt = 0;
          let readinessResult;
          do {
            readinessResult = await runProcess({
              label: `remote:${target.name}`,
              command: 'ssh',
              args: [
                ...openSsh.sshArgs,
                '-o',
                'BatchMode=yes',
                target.ssh,
                buildRemoteForwardProbeCommand(target, { remoteServerPort }),
              ],
              env: infraEnv,
            });
            if (readinessResult?.code === 0 || tunnel.exitCode != null || Date.now() >= readinessDeadline) {
              break;
            }
            readinessAttempt += 1;
            const retryOutcome = await Promise.race([
              waitForRetry({
                attempt: readinessAttempt,
                delayMs: READINESS_RETRY_INTERVAL_MS,
                target,
              }).then(() => 'retry'),
              closeRequested.then(() => 'close'),
            ]);
            if (retryOutcome === 'close' || closed) return null;
          } while (!closed);
          requireSuccessful(
            readinessResult,
            `${target.name} reverse tunnel readiness`,
          );
        }
        beginPhase('worker');
        // Once a server command might create data, its target must remain the
        // authority even if SSH dies before readiness is observed.
        await pinServerDataAuthority();
        const worker = spawnProcess({
          label: `remote:${target.name}`,
          command: 'ssh',
          args: buildSshWorkerArgs(target, {
            remoteCommand,
            sshArgs: openSsh.sshArgs,
          }),
          env: infraEnv,
        });
        workersByTarget.set(target.name, worker);
        startedRemoteTargets.add(target.name);
        if (deferCompanionPreparation && !provisionedTargets.has(target.name)) {
          deferredCompanionPreparationsByTarget.set(target.name, {
            run: prepareRemoteServices,
            phase: () => phase,
          });
        }
        if (services.server) {
          beginPhase('server-readiness');
        } else if (services.expo) {
          beginPhase('expo-readiness');
        } else {
          beginPhase('daemon-readiness');
        }
        return worker;
      } catch (error) {
        if (tunnel && (createdTunnel || phase === 'tunnel')) {
          if (tunnelsByTarget.get(target.name) === tunnel) {
            tunnelsByTarget.delete(target.name);
          }
          await stopProcess(tunnel).catch(() => {});
        }
        targetFailuresByTarget.set(target.name, { name: target.name, phase, error });
        const ownershipRefusal = error.code === 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED';
        publishTargetState(plan, ownershipRefusal ? 'failed' : 'retrying', {
          phase,
          error: error instanceof Error ? error.message : String(error),
        });
        logger.error?.(
          `[dev-targets] ${target.name} ${phase} failed; continuing with other targets: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (retainedRuntime && !startedRemoteTargets.has(target.name)) {
          const unavailable = error.commandExitCode === 255
            || (error.name === 'OpenSshExecutionError' && error.code === 'command_failed' && error.status === 255);
          if (unavailable && !retainedRemoteData && !serverAuthorityPinned) error.remotePreDispatchUnavailable = true;
          throw error;
        }
        return null;
      }
    };

    const startTargetLifecycle = (plan, index, initialWorker, initialTunnel) => {
      const { target, services } = plan;
      if (targetFailuresByTarget.get(target.name)?.error?.code === 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED') return;
      lifecycleTasks.push((async () => {
        let worker = initialWorker;
        let tunnel = initialTunnel;
        let retryAttempt = 0;
        let serverReady = !services.server;
        let companionPreparationReady = retainedRuntime || !planDefersRemoteCompanionPreparation(plan)
          || provisionedTargets.has(target.name);
        let expoReady = !services.expo;
        let daemonReady = !services.daemon;
        const readinessPhase = () => {
          if (!serverReady) return 'server-readiness';
          if (!companionPreparationReady) return 'bootstrap';
          if (!expoReady) return 'expo-readiness';
          if (!daemonReady) return 'daemon-readiness';
          return null;
        };
        const readinessServiceStatus = (overrides = {}) => ({
          ...(services.server ? { server: overrides.server ?? (serverReady ? 'running' : 'starting') } : {}),
          ...(services.expo ? { expo: overrides.expo ?? (expoReady ? 'running' : 'starting') } : {}),
          ...(services.daemon ? { daemon: overrides.daemon ?? (daemonReady ? 'running' : 'starting') } : {}),
        });
        const publishReadiness = () => {
          if (serverReady && expoReady && daemonReady) {
            targetFailuresByTarget.delete(target.name);
            publishTargetState(plan, 'running');
            return;
          }
          publishTargetState(plan, 'starting', {
            phase: readinessPhase(),
            serviceStatus: readinessServiceStatus(),
          });
        };
        const waitForReadinessRetry = async () => {
          const retryOutcome = await Promise.race([
            waitForRetry({ attempt: 1, delayMs: READINESS_RETRY_INTERVAL_MS, target }).then(() => 'retry'),
            closeRequested.then(() => 'close'),
          ]);
          return retryOutcome !== 'close' && !closed;
        };
        while (!closed) {
          if (worker && tunnel) {
            if (serverReady && !companionPreparationReady) {
              const deferredPreparation = deferredCompanionPreparationsByTarget.get(target.name);
              try {
                if (!deferredPreparation) {
                  throw new Error(`[dev-targets] ${target.name} deferred companion preparation is unavailable`);
                }
                await deferredPreparation.run();
                companionPreparationReady = true;
                publishReadiness();
                continue;
              } catch (error) {
                const phase = deferredPreparation?.phase?.() ?? 'bootstrap';
                const failureMessage = `${target.name} remote companion preparation failed: ${
                  error instanceof Error ? error.message : String(error)
                }`;
                targetFailuresByTarget.set(target.name, {
                  name: target.name,
                  phase,
                  error: new Error(failureMessage),
                });
                const ownershipRefusal = error.code === 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED';
                publishTargetState(plan, ownershipRefusal ? 'failed' : 'degraded', {
                  phase,
                  error: failureMessage,
                  serviceStatus: readinessServiceStatus({
                    ...(services.expo ? { expo: 'degraded' } : {}),
                    ...(services.daemon ? { daemon: 'degraded' } : {}),
                  }),
                });
                if (ownershipRefusal) return;
                if (!await waitForReadinessRetry()) return;
                continue;
              }
            }
            const readinessController = (!serverReady || !expoReady || !daemonReady)
              ? new AbortController()
              : null;
            const outcomePromises = [
              waitForProcess(worker).then((result) => ({ kind: 'worker-exit', result })),
              waitForProcess(tunnel).then((result) => ({ kind: 'tunnel-exit', result })),
              closeRequested.then(() => ({ kind: 'close' })),
            ];
            if (readinessController) {
              if (!serverReady) {
                outcomePromises.push(
                  waitForServerReady({
                    url: `http://127.0.0.1:${localServerPort}`,
                    target,
                    env,
                    signal: readinessController.signal,
                  }).then(() => verifyLoadedRuntimeIdentity(plan, 'server')).then(
                    () => ({ kind: 'server-ready' }),
                    (error) => ({ kind: 'server-readiness-failed', error }),
                  ),
                );
              } else {
                if (!expoReady) outcomePromises.push(
                  waitForExpoReady({
                    port: localExpoPort,
                    target,
                    env,
                    signal: readinessController.signal,
                  }).then(
                    () => ({ kind: 'expo-ready' }),
                    (error) => ({ kind: 'expo-readiness-failed', error }),
                  ),
                );
                if (!daemonReady) outcomePromises.push(
                  credentialPreparationsByTarget.get(target.name)(readinessController.signal).then(() => {
                    readinessController.signal.throwIfAborted();
                    const readiness = waitForDaemonReady({
                      target,
                      stackName,
                      sshArgs: openSsh.sshArgs,
                      runProcess,
                      env: infraEnv,
                      signal: readinessController.signal,
                      runtimeMode,
                    });
                    return sourceSnapshot || (controlled && !services.server)
                      ? readiness.then(() => verifyLoadedRuntimeIdentity(plan, 'daemon'))
                      : readiness;
                  }).then(
                    () => ({ kind: 'daemon-ready' }),
                    (error) => ({ kind: 'daemon-readiness-failed', error }),
                  ),
                );
              }
            }
            const outcome = await Promise.race(outcomePromises);
            readinessController?.abort();
            if (outcome.kind === 'close' || closed) return;
            const readyService = outcome.kind === 'server-ready'
              ? 'server'
              : outcome.kind === 'expo-ready'
                ? 'expo'
                : outcome.kind === 'daemon-ready'
                  ? 'daemon'
                  : null;
            if (readyService) {
              if (readyService === 'server') serverReady = true;
              if (readyService === 'expo') expoReady = true;
              if (readyService === 'daemon') daemonReady = true;
              retryAttempt = 0;
              publishReadiness();
              continue;
            }
            const failedService = outcome.kind === 'server-readiness-failed'
              ? 'server'
              : outcome.kind === 'expo-readiness-failed'
                ? 'expo'
                : outcome.kind === 'daemon-readiness-failed'
                  ? 'daemon'
                  : null;
            if (failedService) {
              const phase = `${failedService}-readiness`;
              const failureMessage = `${target.name} remote ${failedService} readiness failed: ${
                outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
              }`;
              targetFailuresByTarget.set(target.name, {
                name: target.name,
                phase,
                error: new Error(failureMessage),
              });
              publishTargetState(plan, 'degraded', {
                phase,
                error: failureMessage,
                serviceStatus: readinessServiceStatus({ [failedService]: 'degraded' }),
              });
              if (!await waitForReadinessRetry()) return;
              continue;
            }

            if (workersByTarget.get(target.name) === worker) {
              workersByTarget.delete(target.name);
            }
            const tunnelExited = outcome.kind === 'tunnel-exit';
            if (tunnelExited && tunnelsByTarget.get(target.name) === tunnel) {
              tunnelsByTarget.delete(target.name);
            }
            await stopProcess(worker);
            if (tunnelExited) {
              await stopProcess(tunnel);
            }
            const failurePhase = tunnelExited ? 'tunnel' : 'worker';
            const code = String(outcome.result?.code ?? 'unknown');
            const failureMessage = `${target.name} remote ${outcome.kind} (code=${code})`;
            targetFailuresByTarget.set(target.name, {
              name: target.name,
              phase: failurePhase,
              error: new Error(failureMessage),
            });
            publishTargetState(plan, 'retrying', {
              phase: failurePhase,
              error: failureMessage,
            });
            logger.error?.(
              `[dev-targets] ${failureMessage}; retrying target lifecycle`,
            );
            worker = null;
            serverReady = !services.server;
            expoReady = !services.expo;
            daemonReady = !services.daemon;
            if (tunnelExited) {
              tunnel = null;
            }
          }

          while (!closed) {
            retryAttempt += 1;
            const retryDelayMs = resolveRetryDelayMs(retryAttempt);
            const retryOutcome = await Promise.race([
              waitForRetry({
                attempt: retryAttempt,
                delayMs: retryDelayMs,
                target,
              }).then(() => 'retry'),
              closeRequested.then(() => 'close'),
            ]);
            if (retryOutcome === 'close' || closed) return;
            worker = await startTarget(plan, index, tunnel);
            if (targetFailuresByTarget.get(target.name)?.error?.code === 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED') return;
            if (worker === TARGET_SYNC_READY) return;
            tunnel = tunnelsByTarget.get(target.name) ?? null;
            if (worker && tunnel) {
              serverReady = !services.server;
              companionPreparationReady = retainedRuntime || !planDefersRemoteCompanionPreparation(plan)
                || provisionedTargets.has(target.name);
              expoReady = !services.expo;
              break;
            }
          }
        }
      })());
    };

    const syncFailedTargets = [];
    await Promise.all(plans.map(async (plan, index) => {
      const { target } = plan;
      const initialWorker = await startTarget(plan, index);
      const initialTunnel = tunnelsByTarget.get(target.name) ?? null;
      const initialFailure = targetFailuresByTarget.get(target.name);
      if (initialWorker === TARGET_SYNC_READY) return;
      if (!initialWorker && initialFailure?.phase === 'sync') {
        syncFailedTargets.push({ plan, index, initialWorker, initialTunnel });
        return;
      }
      startTargetLifecycle(plan, index, initialWorker, initialTunnel);
    }));
    if (
      workersByTarget.size === 0
      && targetFailuresByTarget.size > 0
      && [...targetFailuresByTarget.values()].every(({ phase }) => phase === 'sync')
    ) {
      throw [...targetFailuresByTarget.values()].at(-1).error;
    }
    for (const { plan, index, initialWorker, initialTunnel } of syncFailedTargets) {
      startTargetLifecycle(plan, index, initialWorker, initialTunnel);
    }

    return {
      get workers() {
        return [...workersByTarget.values()];
      },
      projectFile,
      get targetFailures() {
        return [...targetFailuresByTarget.values()];
      },
      async close() {
        if (closed) return;
        closed = true;
        resolveCloseRequested();
        let stopFailure = null;
        for (const plan of servicePlans) {
          const { target } = plan;
          if (!startedRemoteTargets.has(target.name)) continue;
          const options = remoteStackOptionsByTarget.get(target.name);
          try {
            await retireRemoteTarget(target, options, { probeBeforeStop: false });
            await publishTargetState(plan, 'stopped', { phase: null, error: null });
          } catch (error) {
            stopFailure ??= error;
            await publishTargetState(plan, 'failed', { phase: 'stop', error: error instanceof Error ? error.message : String(error) });
          }
        }
        for (const worker of workersByTarget.values()) {
          await stopProcess(worker);
        }
        for (const tunnel of tunnelsByTarget.values()) {
          await stopProcess(tunnel);
        }
        await Promise.allSettled(lifecycleTasks);
        await stopProcess(monitorWorker);
        await syncProject.release('pause');
        if (stopFailure) throw stopFailure;
      },
    };
  } catch (error) {
    closed = true;
    resolveCloseRequested();
    if (syncProject) for (const plan of servicePlans) {
      const { target } = plan;
      if (!startedRemoteTargets.has(target.name)) continue;
      try {
        await retireStackDevTarget({ target, options: remoteStackOptionsByTarget.get(target.name),
          sshArgs: syncProject.openSsh.sshArgs, env: infraEnv, probeBeforeStop: false }, { runProcess, logger });
        await publishTargetState(plan, 'stopped', { phase: null, error: null });
      } catch (cleanupError) {
        await publishTargetState(plan, 'failed', { phase: 'stop', error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
      }
    }
    for (const worker of workersByTarget.values()) {
      await stopProcess(worker).catch(() => {});
    }
    for (const tunnel of tunnelsByTarget.values()) {
      await stopProcess(tunnel).catch(() => {});
    }
    await stopProcess(monitorWorker).catch(() => {});
    await syncProject?.release(syncProject.projectCreated ? 'terminate' : 'pause').catch(() => {});
    throw error;
  }
}

export function startStackDevTargetsInBackground(
  options,
  {
    startStackDevTargetsImpl = startStackDevTargets,
    waitForRetry = defaultWaitForRetry,
    logger = console,
  } = {},
) {
  let activeController = null;
  let closing = false;
  let closedByReady = false;
  let resolveCloseRequested;
  const closeRequested = new Promise((resolve) => {
    resolveCloseRequested = resolve;
  });
  const ready = (async () => {
    let attempt = 0;
    while (!closing) {
      try {
        const controller = await startStackDevTargetsImpl(options);
        activeController = controller;
        if (closing) {
          await activeController?.close?.();
          closedByReady = true;
        }
        return controller;
      } catch (error) {
        attempt += 1;
        const delayMs = resolveRetryDelayMs(attempt);
      for (const plan of options?.targetPlans ?? []) {
        try {
          const pending = options?.onTargetStateChange?.({
            name: plan.target.name,
            commands: plan.commands === true,
            services: { ...plan.services },
            status: 'retrying',
            phase: 'startup',
            error: error instanceof Error ? error.message : String(error),
          });
          pending?.catch?.(() => {});
        } catch {}
      }
      logger.error?.(
          `[dev-targets] startup failed; retrying while the local Stack remains available: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
        const retryOutcome = await Promise.race([
          waitForRetry({ attempt, delayMs }).then(() => 'retry'),
          closeRequested.then(() => 'close'),
        ]);
        if (retryOutcome === 'close' || closing) return null;
      }
    }
    return null;
  })();

  return {
    ready,
    async close() {
      if (closing) return;
      closing = true;
      resolveCloseRequested();
      const controller = activeController ?? await ready;
      if (controller && controller !== activeController) {
        activeController = controller;
      }
      if (!closedByReady) {
        await activeController?.close?.();
        closedByReady = true;
      }
    },
  };
}
