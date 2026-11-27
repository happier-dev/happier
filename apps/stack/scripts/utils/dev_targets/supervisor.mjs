import { randomUUID } from 'node:crypto';
import { respondToSourceRevisionArchiveRequest } from './source_revision_archive_transport.mjs';
import { basename, join } from 'node:path';
import { EventEmitter, on } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls';
import { packControlledRuntimeSnapshot, transferRuntimeFile, removeRemoteRuntimeTransferArchives } from './runtime_artifact_transfer.mjs';
import { ensureRemoteServerDataReady } from './retained_server_data.mjs';
import { carryStackOwnServerIdentityRecord } from './server_identity_record.mjs';
import { resolveStackOwnServerIdentityRecordPath } from '../stack/server_profile_reconciliation.mjs';
import { isAuthFlowEnabled, resolveStackDaemonStartRequested } from '../auth/daemon_gate.mjs';
import { waitForStackCredentialPath } from '../auth/wait_for_credentials.mjs';
import { findExistingStackCredentialPath } from '../auth/credentials_paths.mjs';
import { getStackRuntimePendingRemoteTargets, readStackRuntimeStateFile } from '../stack/runtime_state.mjs';
import { readStackPortAllocations } from '../stack/runtime_ports.mjs';
import { buildRemoteServicePortSelectionCommand } from './service_ports.mjs';
import { normalizeStackRuntimeOwnerStartedAt } from '../stack/runtime_owner_incarnation.mjs';
import { sourceWebExportDiagnosticEnv } from '../../build/sourceWebExportArgs.mjs';
import { resolveRuntimeBuildAuthority } from '../../runtime/shared/runtime_build_authority.mjs';
import { coercePort } from '../server/port.mjs';
import { parseSourcePreparationPhaseLine, SOURCE_START_SUPERSEDED_MARKER, supersededError } from '../../runtime/shared/pending_source_start.mjs';
import { formatSourceReloadRefusal, parseSourceReloadRefusalLine, recordSourceReloadRefusal } from '../../runtime/shared/source_reload_refusal.mjs';
import { parseSourceRuntimeSourceCapturesLine, parseSourceRuntimeSourceTimesLine } from '../../runtime/shared/source_bundle_record.mjs';

import { appendBoundedTail, formatFailureDiagnostic, killProcessTree, redactFailureDiagnostic, run, spawnProc } from '../proc/proc.mjs';
import { createForwardReadiness } from './forward_readiness.mjs';
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
import { defaultSpawnProcess as spawnDevTargetProcess, inspectDevTargetSync, runDevTargetCommand, runDevTargetDependencyBootstrap } from './executor.mjs';
import { startDevTargetRuntime } from './managed_runtime.mjs';
import { repairRecoverableDevTargetSyncConflicts } from './sync_service.mjs';
import { retireStackDevTarget } from './retirement.mjs';
import { waitForExpoMetroRunning } from '../expo/expo.mjs';
import { resolveServerReadyTimeoutMs, waitForServerReady as waitForHappierServerReady } from '../server/server.mjs';
import { parseDaemonReadinessLine } from './daemon_readiness.mjs';
import { SOURCE_SERVER_READY_LINE, SOURCE_SERVER_STARTING_LINE } from './runtime_observer.mjs';
import {
  buildRemoteStackCommand,
  buildRemoteStackOperationCommand,
  buildRemoteStackAttachCommand,
  parseRemoteStackEnvironmentRefusal,
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
  projectRemoteGuestCliPayloadEnvironment,
  resolveRemoteServerRuntimeConfig,
} from './remote_commands.mjs';

const TARGET_SYNC_READY = Symbol('TARGET_SYNC_READY');

/** Prepare on the actual service hosts while their incumbent supervisor is
 * still serving. The existing executor/control pipe owns each preparation
 * worker; only the existing restart owner may subsequently retire services.
 */
export async function prepareStackDevTargetSourceReload({ stackName, stackBaseDir, repoDir, placement, args, env, signal, serverRequested, onPhase, onLog, sourceStartRequestId,
  sourceRevisionDescriptorPath },
  { runProcess = runDevTargetControlProcess, executorDependencies = {}, transferFile = transferRuntimeFile } = {}) {
  env = { ...env, HAPPIER_STACK_SYNC_SOURCE_DIR: repoDir, HAPPIER_STACK_PROCESS_KIND: 'infra',
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: placement.authority.producerStackName
      ?? basename(placement.authority.producerStackBaseDir) };
  const daemonRequested = resolveStackDaemonStartRequested({ env, noDaemon: args.includes('--no-daemon') });
  const plans = placement.targetPlans.map(plan => ({ ...plan, services: { ...plan.services,
    server: plan.services.server && serverRequested,
    daemon: plan.services.daemon && daemonRequested,
  } })).filter(plan => plan.services.server || plan.services.daemon);
  const producerStackBaseDir = placement.authority.producerStackBaseDir;
  const sync = await ensureDevTargetSyncProject({ stackBaseDir: producerStackBaseDir,
    sourceDir: repoDir, targets: placement.config.targets, requiredTargets: plans.map(plan => plan.target),
    ownerId: process.pid, allowIndependentBorrow: true, borrowOnly: true, env }, { runProcess });
  for (const { target } of plans) {
    if (sync.unhealthyTargets.get(target.name) !== 'unhealthy') continue;
    await repairRecoverableDevTargetSyncConflicts({ target, stackBaseDir: producerStackBaseDir,
      sourceDir: repoDir, env: sync.env, signal,
      onWait: () => onPhase?.(target.name, { phase: 'queued' }) },
    { runControl: runProcess, runCommand: input => runDevTargetCommand(input, executorDependencies) });
  }
  const workers = [];
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const close = async () => {
    for (const worker of workers) worker.child?.stdin.write('cancel\n');
    cancellation.abort(new Error('[reload] preparation workers closed'));
    await Promise.allSettled(workers.map(worker => worker.completion));
    signal.removeEventListener('abort', cancel);
  };
  try {
    await Promise.all(plans.map(async plan => {
      const paths = resolveRemoteStackStatePaths(plan.target, { stackName, runtimeMode: 'source-snapshot' });
      const serverConfig = resolveRemoteServerRuntimeConfig({
        serverComponentName: env.HAPPIER_STACK_SERVER_COMPONENT ?? 'happier-server-light', env });
      const hostArgs = args.filter(arg => arg !== '--restart' && arg !== '--reuse-source-runtime');
      if (!plan.services.server) hostArgs.push('--no-server', '--no-ui');
      if (!plan.services.daemon) hostArgs.push('--no-daemon');
      if (sourceRevisionDescriptorPath) {
        // Mirrors carry no Git metadata: ship the controller's revision description.
        // The host's reload worker deletes it once its preparation has consumed it.
        // scp cannot create directories: a Stack's first start on a host has no
        // state directory yet, so use the host's shared stack-state root.
        const remotePath = `${paths.stackStorageDir}/source-revision-${paths.stackName}-${randomUUID()}.json.gz`;
        await transferFile({ target: plan.target, direction: 'upload', localPath: sourceRevisionDescriptorPath, remotePath,
          signal: cancellation.signal });
        hostArgs.push(`--source-revision=${remotePath}`);
      }
      let prepared;
      const ready = new Promise(resolve => { prepared = resolve; });
      const worker = { sourceCaptures: {}, sourceTimes: {
        ...(plan.services.server ? { server: null } : {}),
        ...(plan.services.daemon ? { daemon: null } : {}),
      } };
      const diagnostic = { out: '', err: '' };
      let printed = false;
      let refusal = null;
      let phaseProjection = Promise.resolve();
      let phaseError;
      workers.push(worker);
      worker.completion = runDevTargetCommand({ target: plan.target,
        stackBaseDir: placement.authority.producerStackBaseDir, sourceDir: repoDir,
        commandArgs: ['node', '--conditions=happier-source', '--import=./apps/stack/bin/localSourceRuntimeBootstrap.mjs',
          './apps/stack/scripts/runtime/launch/prepareSourceRuntimeReload.mjs', '--worker',
          JSON.stringify({ stackName, stackBaseDir: paths.stackBaseDir, repoDir: plan.target.repoDir, args: hostArgs, sourceStartRequestId })],
        environment: { ...serverConfig.environment, HAPPIER_DB_PROVIDER: serverConfig.dbProvider,
          ...(plan.services.server ? sourceWebExportDiagnosticEnv(env) : {}),
          ...projectRemoteGuestCliPayloadEnvironment(env),
          HAPPIER_STACK_SERVER_COMPONENT: serverConfig.serverComponentName,
          HAPPIER_STACK_REPO_DIR: plan.target.repoDir, HAPPIER_STACK_STACK: stackName,
          HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: env.HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK,
          HAPPIER_STACK_CLI_HOME_DIR: paths.cliHomeDir, HAPPIER_HOME_DIR: paths.cliHomeDir,
          HAPPIER_SERVER_URL: env.HAPPIER_SERVER_URL,
          ...(env.HAPPIER_WEBAPP_URL ? { HAPPIER_WEBAPP_URL: env.HAPPIER_WEBAPP_URL } : {}),
          HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0', HAPPIER_STACK_SOURCE_MIRROR: '1',
          ...(env.HAPPIER_STACK_EXPO_SOURCE_STACK ? { HAPPIER_STACK_EXPO_SOURCE_STACK: env.HAPPIER_STACK_EXPO_SOURCE_STACK } : {}) },
        controlStdin: true, dependencyAdmission: 'skip', provenance: 'skip',
        signal: cancellation.signal, env, silent: true,
        onLine: ({ stream, line }) => {
          printed = true;
          const failure = stream === 'stderr' ? parseSourceReloadRefusalLine(line, env) : null;
          if (failure) { refusal ??= failure; return; }
          const sourceTimes = stream === 'stdout' ? parseSourceRuntimeSourceTimesLine(line) : null;
          if (sourceTimes) {
            const captures = parseSourceRuntimeSourceCapturesLine(line) ?? {};
            for (const [component, time] of Object.entries(sourceTimes)) {
              if (component === 'ui' ? plan.services.server : plan.services[component]) {
                worker.sourceTimes[component] = time;
                if (captures[component]) worker.sourceCaptures[component] = captures[component];
              }
            }
            return;
          }
          if (respondToSourceRevisionArchiveRequest({ stream, line, target: plan.target, repoDir, transferFile,
            signal: cancellation.signal, writeControl: answer => worker.child?.stdin.write(answer) })) return;
          const preparation = stream === 'stdout' ? parseSourcePreparationPhaseLine(line) : null;
          if (preparation) phaseProjection = phaseProjection.then(() => onPhase?.(plan.target.name, preparation))
            .catch(error => { phaseError = error; });
          else if (stream === 'stdout' && line === 'HSTACK_SOURCE_RELOAD_PREPARED') prepared();
          else {
            const key = stream === 'stderr' ? 'err' : 'out';
            diagnostic[key] = appendBoundedTail(diagnostic[key], `${line}\n`);
            const message = `[reload:${plan.target.name}] ${redactFailureDiagnostic(line, env)}`;
            (stream === 'stderr' ? process.stderr : process.stdout).write(`${message}\n`);
            onLog?.(message);
          }
        },
      }, { ...executorDependencies, spawnProcess: input => {
        // The executor owns its SSH worker's spawn (stdin script frame, process
        // group); this keeps the child only for the control pipe.
        worker.child = (executorDependencies.spawnProcess ?? spawnDevTargetProcess)({ ...input, lifetimeStdin: true });
        worker.child.stdin.on('error', () => {});
        return worker.child;
      } });
      // An exit (including SSH loss) is a failure before readiness, even if
      // the target's old /health is still responding.
      await Promise.race([ready, worker.completion.then(result => {
        throw Object.assign(new Error(`[reload] ${plan.target.name} preparation exited before readiness (${result.code ?? result.signal})`
          + (printed ? '' : `: the remote worker printed nothing before SSH ended${result.diagnosticReason ? ` (${result.diagnosticReason})` : ''}`)
          + formatFailureDiagnostic({
            out: diagnostic.out || result.out || result.stdout,
            err: diagnostic.err || result.err || result.stderr || result.error?.message,
            env,
          })), refusal);
      })]);
      await phaseProjection;
      if (phaseError) throw phaseError;
    }));
    return {
      sourceTimes: Object.assign({}, ...workers.map(worker => worker.sourceTimes)),
      sourceCaptures: Object.assign({}, ...workers.map(worker => worker.sourceCaptures)),
      async activate() {
        signal.throwIfAborted();
        for (const worker of workers) worker.child.stdin.write('activate\n');
        const results = await Promise.all(workers.map(worker => worker.completion));
        if (results.some(result => result.code !== 0)) throw new Error('[reload] remote replacement selection failed; incumbent retained');
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}

export function resolveRemoteServerReadyTimeoutMs(env = process.env) {
  return resolveServerReadyTimeoutMs({ env, defaultTimeoutMs: Infinity });
}

function planRunsRuntimeServices(plan) {
  return Object.values(plan?.services ?? {}).some(Boolean);
}

export function planRequiresRemoteCliWorkspacePreparation(plan) {
  return plan?.services?.daemon === true && plan.preserveDaemon !== true;
}

// --no-daemon declines new execution, but an already retained remote Machine
// still needs this controller's transport. Consume custody rather than choosing
// another placement or treating the configured target as proof of execution.
export function resolvePreservedDaemonTargetPlans({ targetPlans, targets, runtimeState, daemonRequested }) {
  if (daemonRequested) return targetPlans;
  const plans = targetPlans.map(plan => ({ ...plan, services: { ...plan.services, daemon: false } }));
  for (const [name, state] of getStackRuntimePendingRemoteTargets(runtimeState)) {
    if (state.services?.daemon !== true || (state.serviceStatus?.daemon ?? state.status) === 'stopped') continue;
    let plan = plans.find(candidate => candidate.target.name === name);
    if (!plan) {
      const target = targets.find(candidate => candidate.name === name);
      if (!target) throw new Error(`[dev-targets] preserved daemon target ${name} is not configured`);
      plan = { target, services: { server: false, expo: false, daemon: false } };
      plans.push(plan);
    }
    plan.services.daemon = true;
    plan.preserveDaemon = true;
  }
  return plans.filter(plan => plan.commands || planRunsRuntimeServices(plan));
}

function planDefersRemoteCompanionPreparation(plan) {
  return plan?.services?.server === true && planRequiresRemoteCliWorkspacePreparation(plan);
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
  onLine,
}) {
  return spawnProc(label, command, args, env, { silent, persistOutput, lineFilter, onLine });
}

async function defaultStopProcess(child) {
  if (!child || child.exitCode != null) return;
  await killProcessTree(child, 'SIGINT', { graceMs: 2_000 });
}

async function defaultWaitForProcess(child) {
  if (child?.completion) return await child.completion;
  return await new Promise(() => {});
}

export function resolveRetryDelayMs(attempt) {
  return Math.min(60_000, 5_000 * (2 ** Math.max(0, attempt - 1)));
}

async function defaultWaitForRetry({ delayMs, signal }) {
  await waitForAbortableDelay(delayMs, signal);
}

async function defaultWaitForExpoReady({ port, env = process.env, signal } = {}) {
  const timeoutMs = Infinity;
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

async function defaultWaitForServerReady({ url, env = process.env, signal, cliHomeDir, remote, readiness } = {}) {
  if (readiness) {
    signal?.throwIfAborted();
    // Observe the native loaded publication before probing HTTP/identity.
    // The worker's exit and the controller lifetime already bound this wait.
    const changes = on(readiness.events, 'change', { signal });
    try {
      if (!readiness.current) {
        for await (const [ready] of changes) {
          if (ready) break;
        }
      }
    } finally { await changes.return(); }
  }
  const timeoutMs = resolveRemoteServerReadyTimeoutMs(env);
  if (remote) {
    const { target, stackName, runtimeMode, serverPort, sshArgs } = remote;
    await run('ssh', buildSshWorkerArgs(target, { sshArgs,
      remoteCommand: buildRemoteStackOperationCommand(target, { stackName, runtimeMode,
        operation: 'server-readiness', passthrough: [`http://127.0.0.1:${serverPort}`, String(timeoutMs)] }),
    }), { env, signal, captureFailureDiagnostic: true });
    return;
  }
  await waitForHappierServerReady(url, {
    timeoutMs,
    intervalMs: 500,
    signal,
    env,
    cliHomeDir,
  });
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
  onAuthState,
  readiness,
  attaching = false,
} = {}) {
  // A fresh worker's observer speaks only after native runtime startup. A
  // standalone auth probe can report sign-in before its connection exists.
  if (attaching || !readiness) {
    signal?.throwIfAborted();
    const command = buildRemoteDaemonReadinessProbeCommand(target, { stackName, runtimeMode });
    const result = await runProcess({
      label: `remote:${target.name}`,
      command: 'ssh',
      args: [...sshArgs, '-o', 'BatchMode=yes', target.ssh, command],
      env,
      silent: true,
    });
    signal?.throwIfAborted();
    let authState = 'starting';
    if (result?.code === 2) {
      try { authState = JSON.parse(result.out).state ?? 'starting'; } catch {}
    }
    onAuthState?.(authState);
    if (result?.code === 0) return;
    if (!readiness) throw new Error(`[dev-targets] ${target.name} daemon readiness is ${authState}`);
  }
  signal?.throwIfAborted();
  // Subscribe before reading the latest fact, including output received
  // before this target entered its readiness phase.
  const changes = on(readiness.events, 'change', { signal });
  const ready = value => {
    onAuthState?.(value.state);
    return value.state === 'running';
  };
  try {
    if (ready(readiness.current)) return;
    for await (const [value] of changes) {
      if (ready(value)) return;
    }
  } finally {
    await changes.return();
  }
}

function requireSuccessful(result, description) {
  if (result?.code === 0) return;
  if (result?.error?.code === 'ENOENT') {
    throw new Error(
      `[dev-targets] ${description} failed because Mutagen was not found.\n` +
        'Install Mutagen locally and ensure `mutagen` is available on PATH, or remove this stack’s dev-targets.json.',
    );
  }
  // Carry only the producer's closed code, never arbitrary remote output.
  let reasonCode;
  for (const line of String(result?.err ?? '').split(/\r?\n/)) {
    try {
      const failure = JSON.parse(line);
      if (failure.ok === false && /^[a-z][a-z0-9_]*$/.test(failure.error?.code ?? '')) reasonCode = failure.error.code;
    } catch { /* SSH diagnostics need not be JSON. */ }
  }
  const error = new Error(`[dev-targets] ${description} failed (code=${String(result?.code ?? 'unknown')})`
    + (reasonCode ? ` reason=${reasonCode}` : ''));
  error.commandExitCode = result?.code;
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
    sourceStartRequestId,
    sourceCapturedAfter,
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
  if (!retainedRuntime && plans.some((plan) => plan.services.daemon && !plan.preserveDaemon) && !credentialPath && !isAuthFlowEnabled(env)) {
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
  const workerEnvironmentFailures = new WeakMap();
  const remoteStackOptionsByTarget = new Map();
  const startedRemoteTargets = new Set();
  const tunnelsByTarget = new Map();
  const forwardReadinessByTunnel = new WeakMap();
  const servicePortsByTarget = new Map();
  const portAllocationsByTarget = new Map();
  const rememberedPorts = readStackPortAllocations(await readStackRuntimeStateFile(join(stackBaseDir, 'stack.runtime.json')));
  // Only verified loaded identities can authorize retained-runtime recovery.
  const sourceRuntimeObservationsByTarget = new Map();
  const sourcePreparationsByTarget = new Map();
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
  let isSuperseded = false;
  let resolveSuperseded;
  const superseded = new Promise(resolve => { resolveSuperseded = resolve; });
  let resolveCloseRequested;
  const closeRequested = new Promise((resolve) => {
    resolveCloseRequested = resolve;
  });
  // A shared-database stack's daemon host recognizes its own server's Home identity only from its
  // local copy of the record that server wrote. A daemon placed apart from the server starts after
  // that server served (and so recorded), then receives the record over this controller's SSH.
  const serverPlan = servicePlans.find(plan => plan.services.server) ?? null;
  const sharedDatabaseConsumer = Boolean(resolveStackOwnServerIdentityRecordPath(env));
  const carriesServerIdentityRecord = plan => sharedDatabaseConsumer
    && plan.services.daemon && !plan.services.server && !plan.preserveDaemon;
  let announceServerServed;
  const serverServed = new Promise(resolve => { announceServerServed = resolve; });
  const publishTargetState = (plan, status, details = {}) => {
    if (isSuperseded) return;
    if (status !== 'starting') {
      sourcePreparationsByTarget.delete(plan.target.name);
    }
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
    // Native incarnation and listener port are internal startup evidence, not
    // remote-target projection fields (the controller has its own runtime owner).
    const { startedAt: _sourceStartedAt, serverPort: _nativeServerPort, ...sourceRuntimeObservation } = sourceSnapshot
      ? sourceRuntimeObservationsByTarget.get(plan.target.name) ?? {} : {};
    const state = {
      name: plan.target.name,
      commands: plan.commands === true,
      services: { ...plan.services },
      runtimeMode,
      forwardPid: forward && forward.exitCode == null && forward.signalCode == null ? forward.pid ?? null : null,
      ...(publishesServicePorts ? { repoDir: plan.target.repoDir, servicePorts } : {}),
      ...(portAllocationsByTarget.has(plan.target.name) ? { portAllocation: portAllocationsByTarget.get(plan.target.name) } : {}),
      serviceStatus,
      status,
      reason: null,
      ...(status === 'running' ? { phase: null, error: null } : {}),
      ...(controlled && (serviceStatus.server === 'running' || serviceStatus.daemon === 'running')
        ? { runtimeSnapshotId: resolvePlanRuntime(plan).snapshot.snapshotId } : {}),
      ...sourceRuntimeObservation,
      ...(sourceSnapshot ? { sourcePreparation: sourcePreparationsByTarget.get(plan.target.name) ?? null } : {}),
      ...(status === 'running' ? { sourcePreparation: null } : {}),
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
    // Commands and workers own their channels, not the configured master.
    // Native control transport recovers a refused session before dispatch.
    // Foreground forwards and retirement retain their own transport custody.
    const openSsh = syncProject.openSsh;
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

    const verifyLoadedRuntimeIdentity = async (plan, component, excludedOwnerStartedAt) => {
      if (!retainedRuntime && !plan.preserveDaemon) return;
      const { target, services } = plan;
      const result = await runProcess({
        label: `remote:${target.name}`, command: 'ssh', args: [
          ...openSsh.sshArgs, '-o', 'BatchMode=yes', target.ssh,
          buildRemoteRuntimeSnapshotProbeCommand(target, {
            stackName, runtimeMode, sourceUi, snapshotId: resolvePlanRuntime(plan).snapshot?.snapshotId,
            services: sourceSnapshot && component ? { [component]: true } : services,
            includeDaemonServerUrl: plan.preserveDaemon === true,
          }),
        ], env: infraEnv, silent: true,
      });
      requireSuccessful(result, `${target.name} loaded runtime identity`);
      const observed = sourceSnapshot || plan.preserveDaemon ? JSON.parse(result.out) : null;
      if (plan.preserveDaemon) {
        const forward = resolveCanonicalLoopbackForward(observed.daemonServerUrl, localServerPort);
        if (!forward) throw new Error(`[dev-targets] ${target.name} preserved daemon has no verified loopback server endpoint`);
        servicePortsByTarget.set(target.name, { ...servicePortsByTarget.get(target.name), daemon: forward.listenPort });
      }
      if (sourceSnapshot) {
        observed.startedAt = normalizeStackRuntimeOwnerStartedAt(observed.startedAt);
        if (excludedOwnerStartedAt && (!observed.startedAt || observed.startedAt === excludedOwnerStartedAt)) {
          throw new Error(`[dev-targets] ${target.name} replacement runtime incarnation is not loaded`);
        }
        if (!observed.sourceRuntimeIdentities || typeof observed.sourceRuntimeIdentities !== 'object'
          || (component && !observed.sourceRuntimeIdentities[component])) {
          throw new Error(`[dev-targets] ${target.name} source runtime identity observation is missing`);
        }
        const previous = sourceRuntimeObservationsByTarget.get(target.name);
        for (const [observedComponent, identity] of Object.entries(observed.sourceRuntimeIdentities)) {
          const selected = previous?.sourceRuntimeIdentities?.[observedComponent]?.selected;
          // An explicit daemon reload updates the target's canonical selected
          // and loaded launch together. Recovery must consume that attested
          // successor instead of retaining this controller's old observation.
          const loadedDaemonReload = observedComponent === 'daemon'
            && typeof identity.selected === 'string' && identity.selected.length > 0
            && identity.loaded === identity.selected;
          if (selected && identity.selected !== selected && !loadedDaemonReload) {
            throw new Error(`[dev-targets] ${target.name} recovered ${observedComponent} changed its selected source runtime`);
          }
        }
        sourceRuntimeObservationsByTarget.set(target.name, {
          ...previous, ...observed,
          sourceRuntimeIdentities: { ...previous?.sourceRuntimeIdentities, ...observed.sourceRuntimeIdentities },
        });
      }
      return observed;
    };

    const startTargetTunnel = (target, existingTunnel = null) => {
      if (existingTunnel && existingTunnel.exitCode == null && existingTunnel.signalCode == null) return existingTunnel;
      if (existingTunnel && tunnelsByTarget.get(target.name) === existingTunnel) tunnelsByTarget.delete(target.name);
      const forwards = remoteStackOptionsByTarget.get(target.name).forwards;
      const readiness = createForwardReadiness({ forwards, env: infraEnv });
      const tunnel = spawnProcess({
        label: `remote:${target.name}`,
        command: 'ssh',
        args: buildSshForwardArgs(target, {
          forwards,
          sshArgs: openSsh.sshArgs,
          observeReadiness: true,
        }),
        env: infraEnv,
        silent: true,
        persistOutput: false,
        onLine: readiness.onLine,
      });
      forwardReadinessByTunnel.set(tunnel, readiness);
      tunnelsByTarget.set(target.name, tunnel);
      return tunnel;
    };
    const verifyTargetForward = async (plan) => {
      const tunnel = tunnelsByTarget.get(plan.target.name);
      await forwardReadinessByTunnel.get(tunnel).wait({ tunnel, waitForProcess, closeRequested });
      if (plan.services.server) return;
      requireSuccessful(await runProcess({
        label: `remote:${plan.target.name}`,
        command: 'ssh',
        args: [
          ...openSsh.sshArgs, '-o', 'BatchMode=yes', plan.target.ssh,
          buildRemoteForwardProbeCommand(plan.target, {
            remoteServerPort: remoteStackOptionsByTarget.get(plan.target.name).remoteServerPort,
          }),
        ],
        env: infraEnv,
      }), `${plan.target.name} reverse tunnel readiness`);
    };

    const spawnTargetWorker = (plan, remoteCommand) => {
      const { target } = plan;
      const environmentFailure = { refusal: null, sourceRefusal: null, publication: Promise.resolve(), stderrTail: '',
        serverReadiness: { current: false, events: new EventEmitter() },
        daemonReadiness: { current: { state: 'starting' }, events: new EventEmitter() } };
      const worker = spawnProcess({
        label: `remote:${target.name}`, command: 'ssh',
        args: buildSshWorkerArgs(target, { remoteCommand, sshArgs: openSsh.sshArgs }),
        env: infraEnv,
        onLine: ({ stream, line }) => {
          if (stream === 'stdout' && (line === SOURCE_SERVER_READY_LINE || line === SOURCE_SERVER_STARTING_LINE)) {
            environmentFailure.serverReadiness.current = line === SOURCE_SERVER_READY_LINE;
            environmentFailure.serverReadiness.events.emit('change', environmentFailure.serverReadiness.current);
            return;
          }
          const daemonReadiness = stream === 'stdout' ? parseDaemonReadinessLine(line) : null;
          if (daemonReadiness) {
            environmentFailure.daemonReadiness.current = daemonReadiness;
            environmentFailure.daemonReadiness.events.emit('change', daemonReadiness);
            return;
          }
          if (stream === 'stderr') {
            environmentFailure.stderrTail = appendBoundedTail(environmentFailure.stderrTail, `${line}\n`);
            environmentFailure.refusal ??= parseRemoteStackEnvironmentRefusal(line);
          }
          const sourceRefusal = stream === 'stderr' ? parseSourceReloadRefusalLine(line, env) : null;
          if (sourceRefusal) {
            environmentFailure.sourceRefusal ??= Object.assign(new Error('Remote source startup refused' + formatSourceReloadRefusal(sourceRefusal, env)), sourceRefusal);
            environmentFailure.publication = environmentFailure.publication.then(() => recordSourceReloadRefusal({
              stackBaseDir, error: environmentFailure.sourceRefusal, env }))
              .catch(error => logger.error?.(`[dev-targets] reload diagnostic publication failed: ${error.message}`));
          }
          if (sourceSnapshot && stream === 'stdout' && line === SOURCE_START_SUPERSEDED_MARKER) {
            isSuperseded = true;
            resolveSuperseded();
            resolveCloseRequested();
            return;
          }
          const preparation = sourceSnapshot && stream === 'stdout' ? parseSourcePreparationPhaseLine(line) : null;
          if (!preparation || closed) return;
          sourcePreparationsByTarget.set(target.name, preparation);
          publishTargetState(plan, 'starting', { phase: preparation.phase, sourcePreparation: preparation });
        },
      });
      workerEnvironmentFailures.set(worker, environmentFailure);
      workersByTarget.set(target.name, worker);
      startedRemoteTargets.add(target.name);
      return worker;
    };

    // A ready server has created its data: a creation pin stops awaiting data.
    const serverDataObservedTargets = new Set();
    const markServerDataObserved = async (target) => {
      if (serverDataObservedTargets.has(target.name) || !retainedRuntime) return;
      if (typeof onServerDataAuthority === 'function') await onServerDataAuthority({ targetName: target.name, dataObserved: true });
      serverDataObservedTargets.add(target.name);
    };
    const startTarget = async (plan, index, existingTunnel = null, refreshSourceRuntime = false, retryAttempt = 0, transportRecovery = false) => {
      if (isSuperseded) return null;
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
      let credentialWaitReported = false;
      let workspacePreparationCurrent = false;
      let retainedRemoteData = false;
      let serverAuthorityPinned = false;
      const pinServerDataAuthority = async ({ dataObserved = false } = {}) => {
        if (serverAuthorityPinned || !retainedRuntime || !services.server) return;
        if (typeof onServerDataAuthority === 'function') await onServerDataAuthority({ targetName: target.name, dataObserved });
        serverAuthorityPinned = true;
        if (dataObserved) serverDataObservedTargets.add(target.name);
      };
      deferredCompanionPreparationsByTarget.delete(target.name);
      const beginPhase = (nextPhase) => {
        if (isSuperseded) throw supersededError();
        phase = nextPhase;
        publishTargetState(plan, 'starting', { phase });
      };
      const seedRemoteCredential = async () => {
        // Target-native sign-in owns retained auth; controller files cannot seed it.
        if (retainedRuntime) return false;
        if (!services.daemon || credentialSeeded) return true;
        const credentialServerUrl = canonicalServerUrl || publicServerUrl || `http://127.0.0.1:${localServerPort}`;
        const currentCredentialPath = credentialPath || (cliHomeDir
          ? findExistingStackCredentialPath({ cliHomeDir, serverUrl: credentialServerUrl, env })
          : null);
        if (!currentCredentialPath) {
          if (!credentialWaitReported) {
            credentialWaitReported = true;
            beginPhase('credentials');
            logger.info?.(`[dev-targets] waiting for CLI sign-in for ${stackName}: no credential for ${credentialServerUrl}; run \`hstack stack auth ${stackName} login\``);
          }
          return false;
        }
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
      credentialPreparationsByTarget.set(target.name, async (signal, onAuthState) => {
        if (retainedRuntime) return;
        while (!credentialSeeded && !closed) {
          if (signal?.aborted) throw signal.reason;
          try {
            if (await beginCredentialSeed()) return;
            if (!cliHomeDir) return;
            onAuthState?.('sign-in-required');
          } catch (error) {
            credentialSeedTask = null;
            throw error;
          }
          await waitForStackCredentialPath({ cliHomeDir, serverUrl: canonicalServerUrl || publicServerUrl || '', env, signal });
        }
      });
      const prepareRemoteServices = async (signal) => {
        signal?.throwIfAborted();
        if (!deferCompanionPreparation) await beginCredentialSeed();
        beginPhase('bootstrap');
        if (retainedRuntime) {
          beginPhase('sync');
          await flushSync({ target, env: mutagenEnv }, { runProcess });
          beginPhase('bootstrap');
          if (services.server) {
            const readiness = await ensureRemoteServerDataReady({ target, stackName, stackBaseDir, syncStackBaseDir, env: infraEnv }, { runCommand });
            retainedRemoteData = readiness?.retainedRemoteData === true;
            if (retainedRemoteData) await pinServerDataAuthority({ dataObserved: true });
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
        signal?.throwIfAborted();
        requireSuccessful(
          await runDependencyBootstrap({
            target,
            stackBaseDir,
            // Local generated inputs are published immediately before the
            // supervisor starts. Use the existing explicit Mutagen barrier
            // once before executing component bootstrap on the replica.
            syncAlreadyVerified: false,
            flush: true,
            signal,
            env: infraEnv,
          }),
          `${target.name} dependency bootstrap`,
        );
        // Credentials are the deferred daemon's start gate. Do not open it
        // until current workspace bytes and their dependency bootstrap are
        // ready, otherwise the server-first worker can load a stale daemon.
        if (deferCompanionPreparation) await beginCredentialSeed();
        provisionedTargets.add(target.name);
      };
      try {
        beginPhase('prepare');
        let preservedDaemonForward = null;
        let preservedServerPort = null;
        if (plan.preserveDaemon) {
          beginPhase('runtime-identity');
          const observed = await verifyLoadedRuntimeIdentity(plan, 'daemon');
          preservedDaemonForward = resolveCanonicalLoopbackForward(observed.daemonServerUrl, localServerPort);
          if (services.server) {
            preservedServerPort = coercePort(observed.serverPort);
            if (!preservedServerPort) throw new Error(`[dev-targets] ${target.name} preserved daemon requires its co-located server's recorded private port`);
          }
          credentialSeeded = true;
          if (!services.server && !services.expo) provisionedTargets.add(target.name);
        }
        if (!services.server && ['tunnel', 'server-readiness'].includes(targetFailuresByTarget.get(target.name)?.phase)) {
          // A reverse forward cannot reach a server still preparing locally.
          // Recovery uses the same server readiness and controller lifetime as
          // remote server startup, before probing the dependent target again.
          beginPhase('server-readiness');
          const readinessController = new AbortController();
          try {
            const outcome = await Promise.race([
              waitForServerReady({
                url: `http://127.0.0.1:${localServerPort}`,
                target,
                env,
                cliHomeDir,
                signal: readinessController.signal,
              }).then(() => 'ready'),
              closeRequested.then(() => 'close'),
            ]);
            if (outcome === 'close' || closed) return null;
          } finally {
            readinessController.abort();
          }
        }
        if (syncProject.unhealthyTargets?.has(target.name)) {
          beginPhase('sync');
          const syncStatus = await inspectSync({ target, stackBaseDir: syncStackBaseDir, env: infraEnv });
          if (syncStatus.recovery === 'rescan') {
            await flushSync({ target, env: mutagenEnv }, { runProcess });
          } else if (syncStatus.state !== 'ready' && syncStatus.state !== 'synchronizing' && syncStatus.state !== 'needs-flush') {
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
          if (deferCompanionPreparation && remoteWorkspacePreparation) {
            beginPhase('bootstrap');
            try {
              await (typeof remoteWorkspacePreparation === 'function'
                ? remoteWorkspacePreparation()
                : remoteWorkspacePreparation);
              await flushSync({ target, env: mutagenEnv }, { runProcess });
              workspacePreparationCurrent = true;
            } catch (error) {
              throw Object.assign(
                new Error(`[dev-targets] ${target.name} remote companion preparation failed`, { cause: error }),
                { code: 'source_companion_preparation_failed' },
              );
            }
          }
          if (retainedRuntime && hasServices && !deferCompanionPreparation) {
            await prepareRemoteServices();
          }
        }

        if (closed || isSuperseded) return null;
        if (!hasServices) {
          targetFailuresByTarget.delete(target.name);
          publishTargetState(plan, 'running');
          return TARGET_SYNC_READY;
        }
        if (sourceSnapshot && !retainedSourceRuntime && startedRemoteTargets.has(target.name)) {
          // A failed launch may never have published runtime state. Only
          // verified absence permits a fresh start; otherwise recover the
          // loaded identity before changing its route or retiring its runner.
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
        // Retained runtimes and live tunnels keep their endpoint. Fresh choices
        // use the host's canonical socket selector after native retirement.
        const retainedRemoteServerPort = retainedSourceRuntime || (tunnel && tunnel.exitCode == null && tunnel.signalCode == null)
          ? remoteStackOptionsByTarget.get(target.name)?.remoteServerPort : null;
        const rememberedServerPort = rememberedPorts?.servers?.[target.name]?.port;
        let remoteServerPort =
          // A retained daemon keeps its launch route across controller instances.
          // Keep the co-located server on that runtime's private port; its canonical
          // reverse forward is a separate listener and must not become the server.
          preservedServerPort ?? (!services.server ? preservedDaemonForward?.listenPort : null) ?? target.remoteServerPort
          ?? retainedRemoteServerPort ?? (services.server ? rememberedServerPort : null) ?? localServerPort;
        beginPhase('stop');
        // Retirement owns teardown; never mistake our still-running incumbent
        // for a foreign listener while deciding whether a choice can be reused.
        // Source workers own replacement admission and retirement. Keep the
        // incumbent serving while their capture is being prepared or refused.
        if (!sourceSnapshot && (!plan.preserveDaemon || services.server || services.expo) && !retainedSourceRuntime && !refreshSourceRuntime) {
          await retireRemoteTarget(target, { stackName, runtimeMode, preserveDaemon: plan.preserveDaemon === true,
            attended: env.HAPPIER_STACK_TUI === '1' });
        }
        if (closed || isSuperseded) return null;
        const selectPort = async (service, options) => {
          const result = await runProcess({ label: `remote:${target.name}`, command: 'ssh', args: [
            ...openSsh.sshArgs, '-o', 'BatchMode=yes', target.ssh,
            buildRemoteServicePortSelectionCommand(target, { stackName, runtimeMode, service, ...options }),
          ], env: infraEnv });
          requireSuccessful(result, `${target.name} ${service} port selection`);
          const allocation = JSON.parse(result.out ?? '');
          const port = coercePort(allocation?.port);
          if (!port) throw new Error(`[dev-targets] ${target.name} ${service} port selection returned no valid port`);
          return { ...allocation, port };
        };
        if (!preservedServerPort && !preservedDaemonForward && !target.remoteServerPort
          && !retainedRemoteServerPort && !retainedSourceRuntime) {
          const allocation = await selectPort('server', { startPort: localServerPort,
            preferredServerPort: services.server ? rememberedServerPort : null });
          remoteServerPort = allocation.port;
          if (services.server) portAllocationsByTarget.set(target.name, allocation);
        }
        const remoteExpoPort = services.expo
          ? (retainedRemoteServerPort ? remoteStackOptionsByTarget.get(target.name)?.remoteExpoPort : null)
            ?? (await selectPort('expo', { startPort: localExpoPort, reservedPorts: [remoteServerPort] })).port
          : null;
        servicePortsByTarget.set(target.name, {
          ...(services.daemon ? { daemon: remoteServerPort } : {}),
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
          forwards.push(preservedDaemonForward ?? {
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
        if (refreshSourceRuntime) {
          // Worker failure can come from stale last-green bytes. Flush the
          // mirror before the native restart owner prepares current source.
          beginPhase('sync');
          await flushSync({ target, env: mutagenEnv }, { runProcess });
          if (retainedSourceRuntime && !retainedSourceRuntime.startedAt) {
            throw new Error(`[dev-targets] ${target.name} source refresh requires an observed runtime incarnation`);
          }
        }
        const remoteStackOptions = {
          forwards,
          env: sourceSnapshot ? { ...env, HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK:
            resolveRuntimeBuildAuthority({ rootDir: sourceDir, consumerStackName: stackName,
              env: { ...env, HAPPIER_STACK_REPO_DIR: sourceDir }, createRepoIdentityIfMissing: false }).producerStackName } : env,
          runtimeMode,
          sourceStartRequestId,
          sourceCapturedAfter,
          refreshSourceRuntime,
          excludedOwnerStartedAt: refreshSourceRuntime ? retainedSourceRuntime?.startedAt : undefined,
          reuseSourceRuntime: !refreshSourceRuntime && (transportRecovery || Boolean(retainedSourceRuntime) || env.HAPPIER_STACK_PREPARED_SOURCE_RELOAD === '1'),
          preparedSourceReload: !refreshSourceRuntime && sourceSnapshot && !retainedSourceRuntime && env.HAPPIER_STACK_PREPARED_SOURCE_RELOAD === '1',
          // The controller restarts the incumbent revision after its replacement failed.
          sourceSelectionRollback: env.HAPPIER_STACK_SOURCE_SELECTION_ROLLBACK === '1',
          sourceUiLaunch: refreshSourceRuntime ? null : retainedSourceRuntime?.sourceUiLaunch,
          runtimeSnapshotId: selectedSnapshot?.snapshotId,
          borrowedExpoProducerStackName,
          sourceUi,
          services: { ...services, daemon: services.daemon && !plan.preserveDaemon },
          preserveDaemon: plan.preserveDaemon === true,
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
        // Retire recorded source consumers before bootstrap can rewrite the
        // shared dependency tree. Legacy Expo state can outlive runtime state.
        if (!retainedRuntime && !provisionedTargets.has(target.name) && !deferCompanionPreparation) {
          await prepareRemoteServices();
        }
        if (closed) return null;
        const remoteCommand = plan.preserveDaemon && !services.server && !services.expo
          ? null : buildRemoteStackCommand(target, remoteStackOptions);
        beginPhase('tunnel');
        // A worker-only failure keeps a healthy forward, but that forward can
        // die while retirement/backoff is pending. Recheck at dispatch.
        const previousTunnel = tunnel;
        tunnel = startTargetTunnel(target, tunnel);
        createdTunnel = tunnel !== previousTunnel;
        // Initial establishment and reconnect await the owning SSH confirmation.
        await verifyTargetForward(plan);
        const carriesRecord = carriesServerIdentityRecord(plan);
        if (carriesRecord && serverPlan) {
          beginPhase('server-readiness');
          const served = await Promise.race([serverServed.then(() => true), closeRequested.then(() => false)]);
          if (!served || closed) return null;
        }
        beginPhase('worker');
        if (!remoteCommand) return null;
        if (carriesRecord) {
          const serverIdentityId = await carryStackOwnServerIdentityRecord({ stackName, runtimeMode, env: infraEnv,
            serverTarget: serverPlan?.target ?? null, daemonTarget: target, sshArgs: openSsh.sshArgs }, { runProcess });
          if (serverIdentityId) logger.info?.(`[dev-targets] ${target.name} received server identity record ${serverIdentityId} from ${serverPlan?.target.name ?? 'the local server'}`);
          if (closed) return null;
        }
        // Once a server command might create data, its target must remain the
        // authority even if SSH dies before readiness is observed.
        await pinServerDataAuthority();
        if (isSuperseded) return null;
        // A real replacement is admitted through fresh identity probes. An
        // observer-only reattachment never passes through startup or capture.
        if (sourceSnapshot) sourceRuntimeObservationsByTarget.delete(target.name);
        const worker = spawnTargetWorker(plan, remoteCommand);
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
        if (isSuperseded) return null;
        const dependentReadinessFailure = !services.server && (phase === 'tunnel' || phase === 'server-readiness');
        // The first probe can race forward establishment. A reused forward
        // that still fails after local server readiness is not usable merely
        // because its SSH process is alive, even before the first worker starts.
        // Retire it through the existing lifecycle and backoff owner.
        const lostReusedForward = phase === 'tunnel' && tunnel === existingTunnel;
        if (tunnel && (createdTunnel || phase === 'tunnel')
          && (!dependentReadinessFailure || lostReusedForward || tunnel.exitCode != null || tunnel.signalCode != null)) {
          if (tunnelsByTarget.get(target.name) === tunnel) {
            tunnelsByTarget.delete(target.name);
          }
          await stopProcess(tunnel).catch(() => {});
        }
        targetFailuresByTarget.set(target.name, { name: target.name, phase, error });
        publishTargetState(plan, error.retryable === false ? 'failed' : 'retrying', {
          phase,
          error: error instanceof Error ? error.message : String(error),
        });
        if (error.retryable === false) throw error;
        logger.error?.(
          `[dev-targets] ${target.name} ${phase} failed; continuing with other targets: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // Pre-dispatch server/data admission still owns safe local fallback.
        // Daemon preparation and transient sync failures recover under this
        // target's lifecycle without tearing down the independent local Stack.
        if (retainedRuntime && services.server && phase !== 'sync'
          && !startedRemoteTargets.has(target.name) && !dependentReadinessFailure) {
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
      lifecycleTasks.push((async () => {
        let worker = initialWorker;
        let tunnel = initialTunnel;
        let retryAttempt = 0;
        let refreshSourceRuntime = false;
        let reconnectingTunnel = false;
        let transportRecovery = false;
        let discardUnverifiedForward = false;
        let serverReady = !services.server;
        let companionPreparationReady = retainedRuntime || !planDefersRemoteCompanionPreparation(plan)
          || provisionedTargets.has(target.name);
        let expoReady = !services.expo;
        let daemonReady = !services.daemon;
        let daemonAuthState = 'starting';
        const readinessPhase = () => {
          if (daemonAuthState === 'reload-required') return 'reload-required';
          if (serverReady && companionPreparationReady && daemonAuthState === 'sign-in-required') return 'credentials';
          const preparation = sourcePreparationsByTarget.get(target.name);
          if (preparation && preparation.phase !== 'prepared') return preparation.phase;
          if (!serverReady) return 'server-readiness';
          if (!companionPreparationReady) return 'bootstrap';
          if (!expoReady) return 'expo-readiness';
          if (!daemonReady) return 'daemon-readiness';
          return null;
        };
        const readinessServiceStatus = (overrides = {}) => ({
          ...(services.server ? { server: overrides.server ?? (serverReady ? 'running' : 'starting') } : {}),
          ...(services.expo ? { expo: overrides.expo ?? (expoReady ? 'running' : 'starting') } : {}),
          ...(services.daemon ? { daemon: overrides.daemon ?? (daemonReady ? 'running' : daemonAuthState) } : {}),
        });
        const publishReadiness = () => {
          if (serverReady && expoReady && daemonReady) {
            reconnectingTunnel = false;
            transportRecovery = false;
            targetFailuresByTarget.delete(target.name);
            publishTargetState(plan, 'running');
            return;
          }
          publishTargetState(plan, 'starting', {
            phase: readinessPhase(),
            serviceStatus: readinessServiceStatus(),
          });
        };
        const publishDaemonAuthState = state => {
          if (state === daemonAuthState) return;
          daemonAuthState = state;
          if (state === 'sign-in-required') logger.info?.(`[dev-targets] ${plan.target.name} sign-in required for ${stackName}; run \`hstack stack happier ${stackName} --runtime -- auth login\``);
          publishReadiness();
        };
        const waitForTargetRetry = async (interruptions = []) => {
          const cancellation = new AbortController();
          const failure = targetFailuresByTarget.get(target.name)?.error;
          const sourcePreparationFailed = failure?.code === 'source_companion_preparation_failed'
            && !failure.cause?.commandExitCode;
          const pending = sourcePreparationFailed
            ? remoteWorkspacePreparation?.waitForBuild?.({ signal: cancellation.signal }) ?? closeRequested
            : waitForRetry({ attempt: ++retryAttempt, delayMs: resolveRetryDelayMs(retryAttempt), target,
                signal: cancellation.signal });
          try {
            const retryOutcome = await Promise.race([
              Promise.resolve(pending).then(() => 'retry', () => 'retry'),
              closeRequested.then(() => 'close'),
              ...interruptions.map(promise => promise.then(() => 'event')),
            ]);
            return retryOutcome !== 'close' && !closed && !isSuperseded;
          } finally { cancellation.abort(); }
        };
        const verifiedServiceReady = async (service) => {
          try {
            if (service === 'server' || sourceSnapshot || (controlled && !services.server) || reconnectingTunnel) {
              await verifyLoadedRuntimeIdentity(plan, service, remoteStackOptionsByTarget.get(target.name)?.excludedOwnerStartedAt);
            }
            return { kind: `${service}-ready` };
          } catch (error) {
            return { kind: reconnectingTunnel ? 'runtime-identity-failed' : `${service}-readiness-failed`, error };
          }
        };
        while (!closed) {
          if (tunnel && (worker || plan.preserveDaemon)) {
            const readinessController = (!serverReady || !companionPreparationReady || !expoReady || !daemonReady)
              ? new AbortController()
              : null;
            const outcomePromises = [
              ...(worker ? [waitForProcess(worker).then((result) => ({ kind: 'worker-exit', result }))] : []),
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
                    cliHomeDir,
                    ...(sourceSnapshot ? { readiness: workerEnvironmentFailures.get(worker)?.serverReadiness } : {}),
                    ...(retainedRuntime && services.server ? { remote: { target, stackName, runtimeMode,
                      serverPort: servicePortsByTarget.get(target.name).server, sshArgs: openSsh.sshArgs } } : {}),
                    signal: readinessController.signal,
                  }).then(
                    async () => { await markServerDataObserved(target); return verifiedServiceReady('server'); },
                    (error) => ({ kind: 'server-readiness-failed', error }),
                  ),
                );
              } else if (!companionPreparationReady) {
                const deferredPreparation = deferredCompanionPreparationsByTarget.get(target.name);
                outcomePromises.push(Promise.resolve().then(() => {
                  if (!deferredPreparation) throw new Error(`[dev-targets] ${target.name} deferred companion preparation is unavailable`);
                  return deferredPreparation.run(readinessController.signal);
                }).then(() => ({ kind: 'companion-ready' }), error => ({ kind: 'companion-preparation-failed', error })));
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
                const prepareCredentials = () => credentialPreparationsByTarget.get(target.name)(readinessController.signal, publishDaemonAuthState);
                if (!daemonReady) outcomePromises.push(
                  Promise.resolve().then(() => {
                    readinessController.signal.throwIfAborted();
                    const readiness = waitForDaemonReady({
                      target,
                      stackName,
                      sshArgs: openSsh.sshArgs,
                      runProcess,
                      env: infraEnv,
                      signal: readinessController.signal,
                      runtimeMode,
                      onAuthState: publishDaemonAuthState,
                      readiness: workerEnvironmentFailures.get(worker)?.daemonReadiness,
                      attaching: reconnectingTunnel,
                    });
                    return Promise.race([
                      readiness,
                      prepareCredentials().then(() => readiness),
                    ]);
                  }).then(
                    () => verifiedServiceReady('daemon'),
                    (error) => ({ kind: 'daemon-readiness-failed', error }),
                  ),
                );
              }
            }
            const outcome = await Promise.race(outcomePromises);
            readinessController?.abort();
            if (outcome.kind === 'close' || closed || isSuperseded) return;
            if (outcome.kind === 'companion-ready') {
              companionPreparationReady = true;
              retryAttempt = 0;
              publishReadiness();
              continue;
            }
            if (outcome.kind === 'companion-preparation-failed') {
              const phase = deferredCompanionPreparationsByTarget.get(target.name)?.phase?.() ?? 'bootstrap';
              const failureMessage = `${target.name} remote companion preparation failed: ${
                outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
              }`;
              const error = Object.assign(new Error(failureMessage, { cause: outcome.error }), {
                code: 'source_companion_preparation_failed',
              });
              targetFailuresByTarget.set(target.name, { name: target.name, phase, error });
              publishTargetState(plan, 'degraded', { phase, error: failureMessage,
                serviceStatus: readinessServiceStatus({
                  ...(services.expo ? { expo: 'degraded' } : {}),
                  ...(services.daemon ? { daemon: 'degraded' } : {}),
                }),
              });
              if (!await waitForTargetRetry([
                ...(worker ? [waitForProcess(worker)] : []), waitForProcess(tunnel),
              ])) return;
              continue;
            }
            const readyService = outcome.kind === 'server-ready'
              ? 'server'
              : outcome.kind === 'expo-ready'
                ? 'expo'
                : outcome.kind === 'daemon-ready'
                  ? 'daemon'
                  : null;
            if (readyService) {
              if (readyService === 'server') {
                serverReady = true;
                announceServerServed();
              }
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
              const failureMessage = `${target.name} remote ${outcome.kind}: ${
                redactFailureDiagnostic(outcome.error instanceof Error ? outcome.error.message : String(outcome.error), infraEnv)
              }`;
              targetFailuresByTarget.set(target.name, {
                name: target.name,
                phase,
                error: outcome.error,
              });
              logger.error?.(`[dev-targets] ${target.name} phase=${phase} reason=${outcome.kind} status=failed`);
              logger.error?.(`[dev-targets] ${failureMessage}`);
              publishTargetState(plan, 'degraded', {
                phase,
                reason: outcome.kind,
                error: failureMessage,
                serviceStatus: readinessServiceStatus({ [failedService]: 'degraded' }),
              });
              if (!await waitForTargetRetry([
                ...(worker ? [waitForProcess(worker)] : []), waitForProcess(tunnel),
              ])) return;
              continue;
            }

            const workerFailure = outcome.kind === 'worker-exit' && outcome.result?.code !== 0
              ? workerEnvironmentFailures.get(worker) : null;
            const workerOutput = workerFailure ? formatFailureDiagnostic({ err: workerFailure.stderrTail, env: infraEnv }) : '';
            if (workerFailure) await workerFailure.publication;
            // PREPARED already admitted the replacement. A failed activation
            // cannot turn that swap into another source preparation request.
            const preparedReloadFailure = sourceSnapshot && env.HAPPIER_STACK_PREPARED_SOURCE_RELOAD === '1'
              && outcome.kind === 'worker-exit' && Number.isInteger(outcome.result?.code)
              && outcome.result.code !== 0 && outcome.result.code !== 255
              ? Object.assign(new Error(`[reload] ${target.name} prepared replacement exited (code=${outcome.result.code}); repair the runtime failure before explicitly reloading${workerOutput}`),
                { code: 'source_reload_activation_failed', phase: 'activation', retryable: false,
                  exitCode: outcome.result.code }) : null;
            const environmentRefusal = workerFailure?.refusal
              ?? (workerFailure?.sourceRefusal?.retryable === false ? workerFailure.sourceRefusal : null)
              ?? preparedReloadFailure;
            if (environmentRefusal) {
              // Refusal releases transport without acquiring another lifecycle.
              // An incumbent may still be serving behind the exited observer.
              if (sourceSnapshot && (workerFailure?.sourceRefusal || preparedReloadFailure)) startedRemoteTargets.delete(target.name);
              if (workersByTarget.get(target.name) === worker) workersByTarget.delete(target.name);
              if (tunnelsByTarget.get(target.name) === tunnel) tunnelsByTarget.delete(target.name);
              await stopProcess(worker);
              await stopProcess(tunnel);
              targetFailuresByTarget.set(target.name, { name: target.name, phase: environmentRefusal.phase, error: environmentRefusal });
              publishTargetState(plan, 'failed', { phase: environmentRefusal.phase, error: environmentRefusal.message,
                ...(preparedReloadFailure ? { reason: environmentRefusal.code } : {}) });
              logger.error?.(environmentRefusal.message);
              return;
            }

            const tunnelExited = outcome.kind === 'tunnel-exit';
            const workerExited = outcome.kind === 'worker-exit';
            const workerTransportLost = workerExited && outcome.result?.code === 255;
            transportRecovery ||= workerTransportLost;
            // Before any runtime is observed, a failed initial forward may be
            // a generated-port collision. Keep that cold-start recovery path.
            const reconnectTunnel = workerExited || (tunnelExited && (reconnectingTunnel
              || sourceRuntimeObservationsByTarget.has(target.name)
              || (services.server && serverReady) || (services.expo && expoReady) || (services.daemon && daemonReady)));
            transportRecovery ||= tunnelExited && reconnectTunnel;
            if (workerExited) {
              discardUnverifiedForward = ((services.server && !serverReady) || (services.expo && !expoReady))
                && !sourceRuntimeObservationsByTarget.has(target.name);
              if (workersByTarget.get(target.name) === worker) workersByTarget.delete(target.name);
              await stopProcess(worker);
              worker = null;
              // Observation can fail while its detached owner still serves.
              // Apply this replacement policy only after proving absence.
              refreshSourceRuntime = sourceSnapshot && !transportRecovery
                && Number.isInteger(outcome.result?.code) && outcome.result.code !== 255;
            }
            // The control forward has no runtime custody. Losing it must not
            // terminate the independent worker or re-enter source preparation.
            if (!reconnectTunnel) {
              if (workersByTarget.get(target.name) === worker) workersByTarget.delete(target.name);
              refreshSourceRuntime = sourceSnapshot && !transportRecovery && (outcome.kind === 'runtime-identity-failed'
                || (Number.isInteger(outcome.result?.code) && outcome.result.code !== 255));
              if (worker) await stopProcess(worker);
              worker = null;
              reconnectingTunnel = false;
            } else reconnectingTunnel = true;
            if (tunnelExited && tunnelsByTarget.get(target.name) === tunnel) {
              tunnelsByTarget.delete(target.name);
            }
            if (tunnelExited) {
              await stopProcess(tunnel);
            }
            const failurePhase = tunnelExited ? 'tunnel' : outcome.kind === 'runtime-identity-failed' ? 'runtime-identity' : 'worker';
            const code = String(outcome.result?.code ?? 'unknown');
            const failureMessage = outcome.error
              ? `${target.name} remote ${outcome.kind}: ${outcome.error.message ?? String(outcome.error)}`
              : `${target.name} remote ${outcome.kind} (code=${code})${
                tunnelExited ? forwardReadinessByTunnel.get(tunnel)?.diagnostic() ?? '' : ''
              }`;
            targetFailuresByTarget.set(target.name, {
              name: target.name,
              phase: failurePhase,
              error: new Error(failureMessage),
            });
            publishTargetState(plan, 'retrying', {
              phase: failurePhase,
              reason: outcome.kind,
              error: failureMessage,
            });
            logger.error?.(`[dev-targets] ${target.name} phase=${failurePhase} reason=${outcome.kind} status=retrying`);
            logger.error?.(
              `[dev-targets] ${failureMessage}; retrying ${reconnectTunnel ? 'control tunnel' : 'target lifecycle'}`,
            );
            serverReady = !services.server;
            expoReady = !services.expo;
            daemonReady = !services.daemon;
            if (tunnelExited) {
              tunnel = null;
            }
          }

          while (!closed) {
            if (!await waitForTargetRetry()) return;
            if (worker || reconnectingTunnel) {
              try {
                tunnel = startTargetTunnel(target, tunnel);
                await verifyTargetForward(plan);
                reconnectingTunnel = true;
                if (!worker && !plan.preserveDaemon) {
                  const absence = await runProcess({ label: `remote:${target.name}`, command: 'ssh',
                    args: [...openSsh.sshArgs, '-o', 'BatchMode=yes', target.ssh,
                      buildRemoteStackRetirementProbeCommand(target, { stackName, runtimeMode })], env: infraEnv });
                  if (absence?.code === 0) {
                    reconnectingTunnel = false;
                    // Preserve cold-start collision recovery: only a forward
                    // that reached this runtime can retain its generated port.
                    if (discardUnverifiedForward && tunnel) {
                      if (tunnelsByTarget.get(target.name) === tunnel) tunnelsByTarget.delete(target.name);
                      await stopProcess(tunnel);
                      tunnel = null;
                    }
                    worker = await startTarget(plan, index, tunnel, refreshSourceRuntime, retryAttempt, transportRecovery);
                  } else {
                    if (absence?.code !== 1) requireSuccessful(absence, `${target.name} runtime presence`);
                    await verifyLoadedRuntimeIdentity(plan);
                    worker = spawnTargetWorker(plan, buildRemoteStackAttachCommand(target, { stackName, runtimeMode }));
                  }
                }
              } catch (error) {
                if (tunnelsByTarget.get(target.name) === tunnel) tunnelsByTarget.delete(target.name);
                await stopProcess(tunnel).catch(() => {});
                tunnel = null;
                targetFailuresByTarget.set(target.name, { name: target.name, phase: 'tunnel', error });
                publishTargetState(plan, 'retrying', { phase: 'tunnel', error: error.message ?? String(error) });
                logger.error?.(`[dev-targets] ${target.name} control tunnel establishment failed; retrying: ${error.message ?? String(error)}`);
                continue;
              }
            } else {
              try {
                worker = await startTarget(plan, index, tunnel, refreshSourceRuntime, retryAttempt, transportRecovery);
              } catch (error) {
                if (error.retryable !== false) throw error;
                logger.error?.(error.message);
                return;
              }
            }
            if (worker === TARGET_SYNC_READY) return;
            tunnel = tunnelsByTarget.get(target.name) ?? null;
            if (tunnel && (worker || plan.preserveDaemon)) {
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

    await Promise.all(plans.map(async (plan, index) => {
      const { target } = plan;
      const begin = async () => {
        const initialWorker = await startTarget(plan, index);
        const initialTunnel = tunnelsByTarget.get(target.name) ?? null;
        if (initialWorker === TARGET_SYNC_READY) return;
        startTargetLifecycle(plan, index, initialWorker, initialTunnel);
      };
      // A daemon that waits for its separately placed server must not hold startup (or close) on it.
      if (serverPlan && carriesServerIdentityRecord(plan)) {
        lifecycleTasks.push(begin().catch(error => {
          logger.error?.(`[dev-targets] ${target.name} startup failed: ${error instanceof Error ? error.message : String(error)}`);
        }));
      } else await begin();
    }));

    return {
      get workers() {
        return [...workersByTarget.values()];
      },
      projectFile,
      superseded,
      get isSuperseded() { return isSuperseded; },
      get targetFailures() {
        return [...targetFailuresByTarget.values()];
      },
      async close({ preserveDaemon = false } = {}) {
        if (closed) return;
        closed = true;
        resolveCloseRequested();
        let stopFailure = null;
        for (const plan of servicePlans) {
          if (isSuperseded) break;
          const { target } = plan;
          if (!startedRemoteTargets.has(target.name) && !plan.preserveDaemon) continue;
          const options = remoteStackOptionsByTarget.get(target.name);
          try {
            if (startedRemoteTargets.has(target.name) || !preserveDaemon) {
              await retireRemoteTarget(target, { ...options, preserveDaemon }, { probeBeforeStop: false });
            }
            const daemonPreserved = preserveDaemon && plan.services.daemon === true;
            await publishTargetState(plan, daemonPreserved ? 'running' : 'stopped', {
              phase: null, error: null,
              serviceStatus: Object.fromEntries(Object.entries(plan.services).filter(([, enabled]) => enabled === true)
                .map(([service]) => [service, daemonPreserved && service === 'daemon' ? 'running' : 'stopped'])),
            });
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
    if (syncProject && !isSuperseded) for (const plan of servicePlans) {
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
  let closeOptions;
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
          await activeController?.close?.(closeOptions);
          closedByReady = true;
        }
        return controller;
      } catch (error) {
        if (error.retryable === false) throw error;
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
    async close(options) {
      if (closing) return;
      closing = true;
      closeOptions = options;
      resolveCloseRequested();
      const controller = activeController ?? await ready.catch(error => {
        if (error.retryable === false) return null;
        throw error;
      });
      if (controller && controller !== activeController) {
        activeController = controller;
      }
      if (!closedByReady) {
        await activeController?.close?.(closeOptions);
        closedByReady = true;
      }
    },
  };
}
