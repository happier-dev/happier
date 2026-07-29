import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { buildConfigureServerLinks } from '@happier-dev/cli-common/links';

import { checkDaemonStatePingAware } from '../daemon.mjs';
import { findExistingStackCredentialPath } from '../utils/auth/credentials_paths.mjs';
import {
  isAuthFlowEnabled,
  resolveStackDaemonStartRequested,
} from '../utils/auth/daemon_gate.mjs';
import { ensureDir } from '../utils/fs/ops.mjs';
import { readLastLines } from '../utils/fs/tail.mjs';
import { isTcpPortFree, pickNextFreeTcpPort } from '../utils/net/ports.mjs';
import { getComponentDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { resolveLocalhostHost } from '../utils/paths/localhost_host.mjs';
import { killProcessTree, run } from '../utils/proc/proc.mjs';
import {
  DEFAULT_CLI_DIST_BUILD_LOCK_TIMEOUT_MS,
  observeCliDistBuildLock,
  resolveCliDistBuildLockPath,
} from '../utils/proc/cliDistBuildLock.mjs';
import { coercePort } from '../utils/server/port.mjs';
import { waitForHappierHealthOk } from '../utils/server/server.mjs';
import { parseArgs } from '../utils/cli/args.mjs';
import { resolveDevServerConnection } from '../utils/dev/resolveDevServerConnection.mjs';
import { getCliHomeDirFromEnvOrDefault } from '../utils/stack/dirs.mjs';
import { resolveVerifiedStackServerEndpoint, resolveVerifiedStackUiEndpoint } from '../utils/stack/verified_endpoints.mjs';
import { resolveExpoTailscaleEnabled } from '../utils/dev/expo_dev_tailscale.mjs';
import {
  deleteStackRuntimeStateIfOwnedBy,
  getStackRuntimeProcessInstanceFingerprint,
  getStackRuntimeProcessEntries,
  getStackRuntimeStatePath,
  isPidAlive,
  isStackRuntimeProcessTrusted,
  readStackRuntimeStateFile,
  withStackRuntimeStartClaim,
} from '../utils/stack/runtime_state.mjs';
import { normalizeStackRuntimeOwnerStartedAt } from '../utils/stack/runtime_owner_incarnation.mjs';
import { listAllStackNames } from '../utils/stack/stacks.mjs';
import { completeInterruptedStackStopBeforeStart, stopStackWithEnv } from '../utils/stack/stop.mjs';
import { openUrlInBrowser } from '../utils/ui/browser.mjs';
import { preflightDevServerRestart } from '../utils/dev/server.mjs';

import { collectReservedStackPorts, getDefaultPortStart } from './port_reservation.mjs';
import { withStackEnv } from './stack_environment.mjs';
import { resolveStackRuntimeLaunchContext } from '../runtime/launch/resolveStackRuntimeLaunchContext.mjs';

function shouldAwaitRequestedDaemonForBackgroundStart({ scriptPath, args = [], env = {} } = {}) {
  if (scriptPath !== 'run.mjs' && scriptPath !== 'dev.mjs') return false;
  if (!resolveStackDaemonStartRequested({ env, noDaemon: args.includes('--no-daemon') })) return false;
  if (isAuthFlowEnabled(env)) return false;
  return true;
}

async function waitForCanonicalServerHealth(baseUrl, options = {}) {
  const ready = await waitForHappierHealthOk(baseUrl, options);
  if (!ready) {
    throw new Error(`Timed out waiting for Happier server health at ${baseUrl}`);
  }
}

function isSourceDaemonPreparationActive({ env = {} } = {}) {
  const repoDir = String(env.HAPPIER_STACK_REPO_DIR ?? '').trim();
  if (!repoDir) return { active: false, ownerId: null };
  return observeCliDistBuildLock(resolveCliDistBuildLockPath(repoDir), {
    staleAfterMs: DEFAULT_CLI_DIST_BUILD_LOCK_TIMEOUT_MS,
  });
}

export async function waitForBackgroundStackReadiness({
  stackName,
  scriptPath,
  args = [],
  env,
  runtimeStatePath,
  internalServerUrl,
  expectedDaemonDistClosureFingerprint = null,
  sourceDaemonLaunchAttempt = null,
  timeoutMs = 180_000,
  preparationTimeoutMs = DEFAULT_CLI_DIST_BUILD_LOCK_TIMEOUT_MS,
  checkDaemonStateImpl = checkDaemonStatePingAware,
  isRunnerAlive = null,
  waitForServerReadyImpl = waitForCanonicalServerHealth,
  isDaemonPreparationActiveImpl = isSourceDaemonPreparationActive,
} = {}) {
  const readyTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : 180_000;
  const daemonPreparationTimeoutMs =
    Number.isFinite(Number(preparationTimeoutMs)) && Number(preparationTimeoutMs) > 0
      ? Number(preparationTimeoutMs)
      : DEFAULT_CLI_DIST_BUILD_LOCK_TIMEOUT_MS;
  await waitForServerReadyImpl(internalServerUrl, {
    timeoutMs: readyTimeoutMs,
    intervalMs: 300,
  });

  if (!shouldAwaitRequestedDaemonForBackgroundStart({ scriptPath, args, env })) return;

  // Server startup, source CLI preparation, and daemon publication are sequential, independently
  // bounded phases. The build lock can appear after the first daemon observation or hand off
  // between valid owners, so suspend publication while the finite preparation window is active.
  let daemonReadyStartedAt = Date.now();
  let preparationOverallStartedAt = null;
  let preparationOwnerStartedAt = null;
  let preparationOwnerId = null;
  let preparationObserved = false;
  let preparationCompleted = false;
  const stackBaseDir = resolveStackEnvPath(stackName, env).baseDir;
  const cliHomeDir = getCliHomeDirFromEnvOrDefault({ stackBaseDir, env });
  const expectedFingerprint = String(expectedDaemonDistClosureFingerprint ?? '').trim().toLowerCase();
  const observesSourcePreparation = !expectedFingerprint;
  // Runtime-backed launches bring an immutable expected fingerprint. Source launches instead
  // correlate the authenticated daemon fingerprint/process incarnation with this runner's
  // runtime publication, and a true restart must retire the captured incumbent incarnation.
  const sourceLaunchAdmission =
    observesSourcePreparation && sourceDaemonLaunchAttempt && typeof sourceDaemonLaunchAttempt === 'object'
      ? {
          ownerPid: Number(sourceDaemonLaunchAttempt.ownerPid),
          ownerStartedAt: normalizeStackRuntimeOwnerStartedAt(sourceDaemonLaunchAttempt.ownerStartedAt),
          incumbentDaemonPid: Number(sourceDaemonLaunchAttempt.incumbentDaemonPid),
          incumbentDaemonProcessInstanceFingerprint:
            String(sourceDaemonLaunchAttempt.incumbentDaemonProcessInstanceFingerprint ?? '').trim(),
        }
      : null;
  let lastObservation = null;
  while (true) {
    if (typeof isRunnerAlive === 'function' && !isRunnerAlive()) {
      throw new Error(`[stack] ${stackName}: runner exited before requested daemon readiness was published.`);
    }

    const now = Date.now();
    const preparationObservation =
      observesSourcePreparation
      && !preparationCompleted
      && await isDaemonPreparationActiveImpl({ env });
    const preparationActive = typeof preparationObservation === 'object'
      ? preparationObservation?.active === true
      : preparationObservation === true;
    const observedPreparationOwnerId = typeof preparationObservation === 'object'
      ? String(preparationObservation?.ownerId ?? '').trim() || null
      : null;
    if (preparationActive) {
      preparationObserved = true;
      preparationOverallStartedAt ??= now;
      if (preparationOwnerStartedAt === null || observedPreparationOwnerId !== preparationOwnerId) {
        preparationOwnerStartedAt = now;
        preparationOwnerId = observedPreparationOwnerId;
      }
      const ownerExpired = now - preparationOwnerStartedAt >= daemonPreparationTimeoutMs;
      // The canonical lock timeout bounds acquisition, not the acquired build callback. Permit
      // an observed incumbent plus the startup's successor build, while retaining one finite
      // acquisition-plus-build ceiling even if unrelated owners continue handing off the lock.
      const overallExpired =
        now - preparationOverallStartedAt >= daemonPreparationTimeoutMs * 2;
      if (ownerExpired || overallExpired) {
        throw new Error(
          `[stack] ${stackName}: CLI preparation did not complete before timeout ` +
            `(${JSON.stringify(lastObservation)}).`,
        );
      }
    } else if (preparationObserved && !preparationCompleted) {
      preparationCompleted = true;
      daemonReadyStartedAt = now;
    } else if (now - daemonReadyStartedAt >= readyTimeoutMs) {
      break;
    }

    const remainingMs = Math.max(
      100,
      preparationActive
        ? Math.min(
          daemonPreparationTimeoutMs - (now - preparationOwnerStartedAt),
          daemonPreparationTimeoutMs * 2 - (now - preparationOverallStartedAt),
        )
        : readyTimeoutMs - (now - daemonReadyStartedAt),
    );
    const daemonState = await checkDaemonStateImpl(cliHomeDir, {
      serverUrl: internalServerUrl,
      env,
      stackName,
      pingTimeoutMs: Math.min(1_000, remainingMs),
    });
    const runtimeState = await readStackRuntimeStateFile(runtimeStatePath);
    const daemonPid = Number(daemonState?.pid);
    const runtimeDaemonPid = Number(runtimeState?.processes?.daemonPid);
    const observedFingerprint = String(daemonState?.distClosureFingerprint ?? '').trim().toLowerCase();
    const observedProcessInstanceFingerprint =
      String(daemonState?.processInstanceFingerprint ?? '').trim();
    const runtimeDaemonProcessInstanceFingerprint =
      getStackRuntimeProcessInstanceFingerprint(runtimeState, 'daemonPid', runtimeDaemonPid)
      ?? getStackRuntimeProcessInstanceFingerprint(runtimeState, 'daemonPids', runtimeDaemonPid);
    const runtimeDaemonDistClosureFingerprint =
      String(runtimeState?.daemon?.distClosureFingerprint ?? '').trim().toLowerCase();
    const runtimeOwnerPid = Number(runtimeState?.ownerPid);
    const runtimeOwnerStartedAt = normalizeStackRuntimeOwnerStartedAt(runtimeState?.startedAt);
    const sourceOwnerStartedAtMs = Date.parse(String(sourceLaunchAdmission?.ownerStartedAt ?? ''));
    const runtimeOwnerStartedAtMs = Date.parse(String(runtimeOwnerStartedAt ?? ''));
    const incumbentStillObserved = sourceLaunchAdmission
      ? sourceLaunchAdmission.incumbentDaemonProcessInstanceFingerprint
        ? runtimeDaemonProcessInstanceFingerprint ===
          sourceLaunchAdmission.incumbentDaemonProcessInstanceFingerprint
        : Number.isFinite(sourceLaunchAdmission.incumbentDaemonPid)
          && sourceLaunchAdmission.incumbentDaemonPid > 1
          && daemonPid === sourceLaunchAdmission.incumbentDaemonPid
      : false;
    const sourceLaunchAuthenticated = !sourceLaunchAdmission || (
      Number.isFinite(sourceLaunchAdmission.ownerPid)
      && sourceLaunchAdmission.ownerPid > 1
      && runtimeOwnerPid === sourceLaunchAdmission.ownerPid
      && Number.isFinite(sourceOwnerStartedAtMs)
      && Number.isFinite(runtimeOwnerStartedAtMs)
      && runtimeOwnerStartedAtMs >= sourceOwnerStartedAtMs
      && Boolean(runtimeDaemonProcessInstanceFingerprint)
      && (
        !observedProcessInstanceFingerprint
        || observedProcessInstanceFingerprint === runtimeDaemonProcessInstanceFingerprint
      )
      && Boolean(observedFingerprint)
      && runtimeDaemonDistClosureFingerprint === observedFingerprint
      && !incumbentStillObserved
    );
    lastObservation = {
      status: daemonState?.status ?? null,
      daemonPid: Number.isFinite(daemonPid) ? daemonPid : null,
      runtimeDaemonPid: Number.isFinite(runtimeDaemonPid) ? runtimeDaemonPid : null,
      distClosureFingerprint: observedFingerprint || null,
      runtimeDistClosureFingerprint: runtimeDaemonDistClosureFingerprint || null,
      processInstanceFingerprint: observedProcessInstanceFingerprint || null,
      runtimeProcessInstanceFingerprint: runtimeDaemonProcessInstanceFingerprint || null,
      runtimeOwnerPid: Number.isFinite(runtimeOwnerPid) ? runtimeOwnerPid : null,
      runtimeOwnerStartedAt,
      incumbentStillObserved,
    };
    if (
      daemonState?.status === 'running'
      && daemonPid > 1
      && runtimeDaemonPid === daemonPid
      && (!expectedFingerprint || observedFingerprint === expectedFingerprint)
      && sourceLaunchAuthenticated
    ) {
      return;
    }
    await delay(Math.min(250, remainingMs));
  }

  throw new Error(
    `[stack] ${stackName}: server became healthy but requested daemon readiness was not authenticated ` +
      `and published before timeout (${JSON.stringify(lastObservation)}).`,
  );
}

function createSourceDaemonLaunchAttempt({
  runtimeSnapshotId = null,
  startedRuntime = null,
  incumbentRuntime = null,
  requireDaemonReplacement = false,
} = {}) {
  if (String(runtimeSnapshotId ?? '').trim()) return null;
  const ownerPid = Number(startedRuntime?.ownerPid);
  const incumbentDaemonPid = requireDaemonReplacement
    ? Number(incumbentRuntime?.processes?.daemonPid)
    : null;
  return {
    ownerPid,
    ownerStartedAt: normalizeStackRuntimeOwnerStartedAt(startedRuntime?.startedAt),
    incumbentDaemonPid: Number.isFinite(incumbentDaemonPid) && incumbentDaemonPid > 1
      ? incumbentDaemonPid
      : null,
    incumbentDaemonProcessInstanceFingerprint:
      requireDaemonReplacement
        ? (
            getStackRuntimeProcessInstanceFingerprint(
              incumbentRuntime,
              'daemonPid',
              incumbentDaemonPid,
            )
            ?? getStackRuntimeProcessInstanceFingerprint(
              incumbentRuntime,
              'daemonPids',
              incumbentDaemonPid,
            )
          )
        : null,
  };
}

export function hasRecordedRuntimePortsForRestart(runtimeState = null) {
  const ports = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : null;
  return Number(ports?.server) > 0;
}

export function shouldReuseRuntimePortsOnRestart({ wantsRestart = false, runtimeState = null, wasRunning = false } = {}) {
  return Boolean(wantsRestart && (wasRunning || hasRecordedRuntimePortsForRestart(runtimeState)));
}

export function resolveRequestedStackServeUi({ args = [], env = {} } = {}) {
  return !args.includes('--no-ui') && String(env.HAPPIER_STACK_SERVE_UI ?? '1').trim() !== '0';
}

function resolveBackgroundReadinessServerUrl({
  scriptPath,
  args = [],
  env = {},
  localServerUrl,
} = {}) {
  if (scriptPath !== 'dev.mjs') return localServerUrl;
  const { flags, kv } = parseArgs(args);
  return resolveDevServerConnection({
    flags,
    kv,
    env,
    resolvedLocalUrls: {
      internalServerUrl: localServerUrl,
      publicServerUrl: localServerUrl,
      defaultPublicUrl: localServerUrl,
    },
  }).internalServerUrl;
}

export function createOuterStackRuntimeStartPublication({
  stackName,
  scriptPath,
  ephemeral,
  ownerPid,
  ports,
  runtimeSnapshotId,
  args = [],
  env = {},
  logs,
} = {}) {
  return {
    stackName,
    script: scriptPath,
    ephemeral: Boolean(ephemeral),
    ownerPid,
    ports,
    runtimeSnapshotId,
    serveUi: resolveRequestedStackServeUi({ args, env }),
    ...(logs ? { logs } : {}),
  };
}

export async function terminateSpawnedRunnerForBootFailure(
  child,
  {
    runtimeStatePath,
    expectedRuntimeState = null,
    preserveRuntimeState = false,
    killProcessTreeImpl = killProcessTree,
    deleteStackRuntimeStateIfOwnedByImpl = deleteStackRuntimeStateIfOwnedBy,
  } = {},
) {
  const termination = await killProcessTreeImpl(child, 'SIGTERM');
  if (
    termination?.ok === true
    && !preserveRuntimeState
    && runtimeStatePath
    && child?.pid
    && Number(expectedRuntimeState?.ownerPid) === Number(child.pid)
  ) {
    await deleteStackRuntimeStateIfOwnedByImpl(runtimeStatePath, expectedRuntimeState);
  }
  return termination;
}

function isMobileRequestedForDevScript({ args = [], env = process.env } = {}) {
  if (!Array.isArray(args)) return false;
  if (args.includes('--mobile') || args.includes('--with-mobile')) return true;
  return resolveExpoTailscaleEnabled({ env, expoTailscale: args.includes('--expo-tailscale') });
}

export async function inspectExistingStartLikeRuntime({
  stackName = '',
  envPath = '',
  baseDir = '',
  expectedUiDir = '',
  scriptPath,
  args = [],
  env = process.env,
  runtimeState = null,
} = {}) {
  const existingOwnerPid = Number(runtimeState?.ownerPid);
  const existingServerPid = Number(runtimeState?.processes?.serverPid);
  const existingExpoPid = Number(runtimeState?.processes?.expoPid);
  const existingForwarderPid = Number(runtimeState?.processes?.expoTailscaleForwarderPid);
  const existingServerPort = Number(runtimeState?.ports?.server);

  const wantsUi = scriptPath === 'dev.mjs' && !args.includes('--no-ui');
  const wantsMobile = scriptPath === 'dev.mjs' && isMobileRequestedForDevScript({ args, env });
  const runtimeProcessTrustContext = { stackName, envPath };

  const ownerRunning = await isStackRuntimeProcessTrusted(
    existingOwnerPid,
    { ...runtimeProcessTrustContext, key: 'ownerPid' },
  );
  const serverPidRunning = await isStackRuntimeProcessTrusted(
    existingServerPid,
    { ...runtimeProcessTrustContext, key: 'serverPid' },
  );
  const expoPidRunning = await isStackRuntimeProcessTrusted(
    existingExpoPid,
    { ...runtimeProcessTrustContext, key: 'expoPid' },
  );
  const forwarderRunning =
    await isStackRuntimeProcessTrusted(
      existingForwarderPid,
      { ...runtimeProcessTrustContext, key: 'expoTailscaleForwarderPid' },
    );
  const serverEndpoint = await resolveVerifiedStackServerEndpoint({ port: existingServerPort });
  const serverRunning =
    Number.isFinite(existingServerPort) && existingServerPort > 0
      ? serverEndpoint.running
      : serverPidRunning;

  let uiRunning = false;
  let uiPort = null;
  if (wantsUi || wantsMobile) {
    const uiEndpoint = await resolveVerifiedStackUiEndpoint({
      stackName,
      baseDir,
      runtimeState,
      expectedProjectDir: expectedUiDir,
      serverPort: existingServerPort,
      serverRunning,
      serveUiWanted: wantsUi,
      acceptExpoState: wantsUi || wantsMobile,
      requireWeb: wantsUi,
      runtimeBackedStart: Boolean(String(runtimeState?.runtimeSnapshotId ?? '').trim()),
    });
    uiRunning = uiEndpoint.running;
    uiPort = uiEndpoint.port;
  }

  const wasRunning = ownerRunning || serverRunning || uiRunning || serverPidRunning || expoPidRunning || forwarderRunning;
  const nonDevReadyOrOwned = ownerRunning || serverRunning || serverPidRunning;
  const canShortCircuit =
    scriptPath === 'dev.mjs'
      ? serverRunning && (!wantsUi || uiRunning) && (!wantsMobile || uiRunning)
      : nonDevReadyOrOwned;

  return {
    ownerRunning,
    serverRunning,
    uiRunning,
    uiPort,
    wasRunning,
    canShortCircuit,
    wantsUi,
    wantsMobile,
  };
}

export function shouldAdoptOccupiedRuntimePortsForRecovery(existingRuntimeStatus = null) {
  return Boolean(
    existingRuntimeStatus &&
      existingRuntimeStatus.serverRunning &&
      !existingRuntimeStatus.canShortCircuit &&
      (existingRuntimeStatus.wantsUi || existingRuntimeStatus.wantsMobile)
  );
}

export function buildAlreadyRunningMobileMetroArgs(args = []) {
  const out = ['--metro'];
  if (Array.isArray(args) && args.includes('--expo-tailscale')) {
    out.push('--expo-tailscale');
  }
  return out;
}

export async function cleanupFailedRestartAttempt({
  rootDir,
  stackName,
  baseDir,
  env,
  runtimeStatePath,
  expectedRuntimeState = null,
  wantsJson = false,
}) {
  const expectedOwnerPid = Number(expectedRuntimeState?.ownerPid);
  const expectedOwnerStartedAt = normalizeStackRuntimeOwnerStartedAt(expectedRuntimeState?.startedAt);
  if (!Number.isFinite(expectedOwnerPid) || expectedOwnerPid <= 1 || !expectedOwnerStartedAt) {
    return { cleaned: false, reason: 'invalid_owner_identity' };
  }
  let stopResult = null;
  try {
    stopResult = await stopStackWithEnv({
      rootDir,
      stackName,
      baseDir,
      env,
      json: wantsJson,
      noDocker: false,
      aggressive: false,
      sweepOwned: true,
      autoSweep: true,
      preserveDaemon: false,
      expectedOwnerPid,
      expectedOwnerStartedAt,
    });
  } catch {
    // Best-effort cleanup; preserve the original restart failure.
  }
  if (stopResult?.stopAuthorization?.authorized !== true) {
    return {
      cleaned: false,
      reason: stopResult?.stopAuthorization?.reason ?? 'stop_authorization_unconfirmed',
    };
  }
  if (stopResult?.finalization?.finalized === true) {
    return { cleaned: true, reason: stopResult.finalization.reason ?? 'finalized' };
  }
  return { cleaned: false, reason: stopResult?.finalization?.reason ?? 'cleanup_incomplete' };
}

export async function runStackScriptWithStackEnv({ rootDir, stackName, scriptPath, args, extraEnv = {}, background = false }) {
  const isStartLikeScript = scriptPath === 'dev.mjs' || scriptPath === 'run.mjs';
  const isStartLikeJsonDryRun = isStartLikeScript && args.includes('--json');
  await withStackEnv({
    stackName,
    extraEnv,
    reconcileDaemonRuntimeState: !isStartLikeJsonDryRun,
    beforeRuntimeReconcile: isStartLikeScript && !isStartLikeJsonDryRun
      ? async ({ env }) => {
          await completeInterruptedStackStopBeforeStart({
            rootDir,
            stackName,
            baseDir: resolveStackEnvPath(stackName, env).baseDir,
            env,
            json: args.includes('--json'),
          });
        }
      : null,
    fn: async ({ env, envPath, stackEnv, runtimeStatePath, runtimeState }) => {
      const isStartLike = scriptPath === 'dev.mjs' || scriptPath === 'run.mjs';
      const wantsRestart = args.includes('--restart');
      const wantsJson = args.includes('--json');
      if (isStartLikeJsonDryRun) {
        // Dry-run JSON must never allocate ports, write runtime state, or wait for readiness.
        await run(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], { cwd: rootDir, env });
        return;
      }
      const { baseDir } = resolveStackEnvPath(stackName, env);
      const expectedUiDir = getComponentDir(rootDir, 'happier-ui', env);
      let restartCleanupExpectedRuntimeState = runtimeState ?? null;

      let runtimeLaunchContext = { snapshot: null };
      if (scriptPath === 'run.mjs') {
        try {
          runtimeLaunchContext = await resolveStackRuntimeLaunchContext({ argv: args, env });
        } catch (error) {
          if (isStartLike && wantsRestart) {
            let shouldCleanup = shouldReuseRuntimePortsOnRestart({
              wantsRestart,
              runtimeState,
              wasRunning: false,
            });

            if (!shouldCleanup) {
              try {
                const existingRuntimeStatus = await inspectExistingStartLikeRuntime({
                  stackName,
                  envPath,
                  baseDir,
                  expectedUiDir,
                  scriptPath,
                  args,
                  env,
                  runtimeState,
                });
                shouldCleanup = shouldReuseRuntimePortsOnRestart({
                  wantsRestart,
                  runtimeState,
                  wasRunning: existingRuntimeStatus.wasRunning,
                });
              } catch {
                // Preserve the original launch-context failure; cleanup is best-effort.
              }
            }

            if (shouldCleanup) {
              await cleanupFailedRestartAttempt({
                rootDir,
                stackName,
                baseDir,
                env,
                runtimeStatePath,
                expectedRuntimeState: restartCleanupExpectedRuntimeState,
                wantsJson,
              });
            }
          }
          throw error;
        }
      }
      const runtimeSnapshotId = runtimeLaunchContext.snapshot?.snapshotId ?? null;
      if (!isStartLike) {
        await run(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], { cwd: rootDir, env });
        return;
      }

      const pinnedServerPort = Boolean((stackEnv.HAPPIER_STACK_SERVER_PORT ?? '').trim());
      const serverComponent = (stackEnv.HAPPIER_STACK_SERVER_COMPONENT ?? '').toString().trim() || 'happier-server-light';
      const managedInfra =
        serverComponent === 'happier-server'
          ? (stackEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1').toString().trim() !== '0'
          : false;
      let preservedDaemonForRestart = false;

      try {
        // If this is an ephemeral-port stack and it's already running, avoid spawning a second copy.
        const existingOwnerPid = Number(runtimeState?.ownerPid);
        const existingPort = Number(runtimeState?.ports?.server);
        const existingPorts = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : null;
        const existingRuntimeStatus = await inspectExistingStartLikeRuntime({
          stackName,
          envPath,
          baseDir,
          expectedUiDir,
          scriptPath,
          args,
          env,
          runtimeState,
        });
        const wasRunning = existingRuntimeStatus.wasRunning;
        // True restart = there was an active runner for this stack. If the stack is not running,
        // `--restart` should behave like a normal start (allocate new ephemeral ports if needed).
        const isTrueRestart = shouldReuseRuntimePortsOnRestart({ wantsRestart, runtimeState, wasRunning });

        // Restart semantics (stack mode):
        // - Preflight source-backed server rebuilds before stopping the old stack.
        // - Stop stack-owned processes after preflight (runner, daemon, Expo, etc.)
        // - Never kill arbitrary port listeners
        // - Preserve previous runtime ports in memory so a true restart can reuse them
        if (wantsRestart && !wantsJson) {
          if (scriptPath === 'dev.mjs') {
            const { flags, kv } = parseArgs(args);
            const serverConnection = resolveDevServerConnection({
              flags,
              kv,
              env,
              resolvedLocalUrls: {
                internalServerUrl: '',
                publicServerUrl: '',
                defaultPublicUrl: '',
              },
            });
            if (serverConnection.startServer) {
              const serverDir = getComponentDir(rootDir, serverComponent, env);
              await preflightDevServerRestart({
                serverDir,
                serverComponentName: serverComponent,
                serverEnv: env,
                consoleImpl: console,
              });
              env.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE = '1';
            }
          }
          if (isTrueRestart) {
            try {
              await stopStackWithEnv({
                rootDir,
                stackName,
                baseDir,
                env,
                json: false,
                noDocker: false,
                aggressive: false,
                sweepOwned: true,
                preserveDaemon: true,
              });
              preservedDaemonForRestart = true;
            } catch {
              // ignore (fail-closed below on port checks)
            }
          }
        }
        if (existingRuntimeStatus.canShortCircuit) {
          if (!wantsRestart) {
            const verifiedUiPort = Number(existingRuntimeStatus.uiPort);
            const serverPart = Number.isFinite(existingPort) && existingPort > 0 ? ` server=${existingPort}` : '';
            const uiPart =
              scriptPath === 'dev.mjs' && existingRuntimeStatus.wantsUi && Number.isFinite(verifiedUiPort) && verifiedUiPort > 0
                ? ` ui=${verifiedUiPort}`
                : '';
            console.log(`[stack] ${stackName}: already running (pid=${existingOwnerPid}${serverPart}${uiPart})`);

            const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
            const noBrowser = args.includes('--no-browser') || (env.HAPPIER_STACK_NO_BROWSER ?? '').toString().trim() === '1';
            const openBrowser = isInteractive && !wantsJson && !noBrowser;

            const host = resolveLocalhostHost({ stackMode: true, stackName });
            const uiUrl =
              scriptPath === 'dev.mjs'
                ? existingRuntimeStatus.wantsUi && Number.isFinite(verifiedUiPort) && verifiedUiPort > 0
                  ? `http://${host}:${verifiedUiPort}`
                  : null
                : Number.isFinite(existingPort) && existingPort > 0
                  ? `http://${host}:${existingPort}`
                  : null;

            if (uiUrl) {
              const serverUrlForUi = Number.isFinite(existingPort) && existingPort > 0 ? `http://localhost:${existingPort}` : '';
              const uiOpenUrl = serverUrlForUi ? buildConfigureServerLinks({ webappUrl: uiUrl, serverUrl: serverUrlForUi }).webUrl : uiUrl;
              console.log(`[stack] ${stackName}: ui: ${uiOpenUrl}`);
              if (openBrowser) {
                await openUrlInBrowser(uiOpenUrl);
              }
            } else if (scriptPath === 'dev.mjs' && existingRuntimeStatus.wantsUi) {
              console.log(`[stack] ${stackName}: ui: unknown (missing expo.webPort in stack.runtime.json)`);
            }

            // Opt-in: allow starting mobile Metro alongside an already-running stack without restarting the runner.
            // This is important for workflows like re-running `setup-pr` with --mobile after the stack is already up.
            const wantsMobile = isMobileRequestedForDevScript({ args, env });
            if (wantsMobile) {
              await run(process.execPath, [join(rootDir, 'scripts', 'mobile.mjs'), ...buildAlreadyRunningMobileMetroArgs(args)], {
                cwd: rootDir,
                env,
              });
            }
            return;
          }
          // Restart: already handled above (stopStackWithEnv is ownership-gated).
        }

        // Ephemeral ports: allocate at start time, store only in runtime state (not in stack env).
        if (!pinnedServerPort) {
        const reserved = await collectReservedStackPorts({ excludeStackName: stackName });

        // Also avoid ports held by other *running* ephemeral stacks.
        const names = await listAllStackNames();
        for (const n of names) {
          if (n === stackName) continue;
          const p = getStackRuntimeStatePath(n);
          // eslint-disable-next-line no-await-in-loop
          const st = await readStackRuntimeStateFile(p);
          const pid = Number(st?.ownerPid);
          if (!isPidAlive(pid)) continue;
          const ports = st?.ports && typeof st.ports === 'object' ? st.ports : {};
          for (const v of Object.values(ports)) {
            const num = Number(v);
            if (Number.isFinite(num) && num > 0) reserved.add(num);
          }
        }

        const startPort = getDefaultPortStart(stackName);
        const ports = {};

        const parsePortOrNull = (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n > 0 ? n : null;
        };
        // Port reuse:
        // - Hard reuse: `--restart` (fail-closed if ports are occupied unless we can prove stack ownership).
        // - Soft reuse: if the stack previously recorded ports in stack.runtime.json, prefer reusing them
        //   on the next start to keep stack endpoints stable (helps auth + server-scoped state).
        const hasRecordedPorts = hasRecordedRuntimePortsForRestart(runtimeState);
        const wantsSoftReuse = !wantsRestart && hasRecordedPorts && existingPorts;
        const wantsHardReuse = isTrueRestart;
        const adoptOccupiedRuntimePorts = shouldAdoptOccupiedRuntimePortsForRecovery(existingRuntimeStatus);

        const candidatePorts =
          (wantsHardReuse || wantsSoftReuse) && existingPorts
            ? {
                server: parsePortOrNull(existingPorts.server),
                backend: parsePortOrNull(existingPorts.backend),
                pg: parsePortOrNull(existingPorts.pg),
                redis: parsePortOrNull(existingPorts.redis),
                minio: parsePortOrNull(existingPorts.minio),
                minioConsole: parsePortOrNull(existingPorts.minioConsole),
              }
            : null;

        let canReuse =
          candidatePorts &&
          candidatePorts.server &&
          (serverComponent !== 'happier-server' || candidatePorts.backend) &&
          (!managedInfra || (candidatePorts.pg && candidatePorts.redis && candidatePorts.minio && candidatePorts.minioConsole));

        // Soft reuse: if previously recorded ports are occupied, fall back to allocating new ports.
        if (canReuse && wantsSoftReuse && !wantsHardReuse && !adoptOccupiedRuntimePorts) {
          const toCheck = Object.values(candidatePorts)
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n) && n > 0);
          for (const p of toCheck) {
            // eslint-disable-next-line no-await-in-loop
            if (!(await isTcpPortFree(p))) {
              canReuse = false;
              break;
            }
          }
        }

        if (canReuse) {
          ports.server = candidatePorts.server;
          if (serverComponent === 'happier-server') {
            ports.backend = candidatePorts.backend;
            if (managedInfra) {
              ports.pg = candidatePorts.pg;
              ports.redis = candidatePorts.redis;
              ports.minio = candidatePorts.minio;
              ports.minioConsole = candidatePorts.minioConsole;
            }
          }

          // Fail-closed if any of the reused ports are unexpectedly occupied (prevents cross-stack collisions).
          const toCheck = Object.values(ports)
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n) && n > 0);
          for (const p of toCheck) {
            // eslint-disable-next-line no-await-in-loop
            if (!(await isTcpPortFree(p))) {
              if (adoptOccupiedRuntimePorts) {
                continue;
              }
              if (isTrueRestart && !wantsJson) {
                // Try one more safe cleanup of stack-owned processes and re-check.
                const baseDir = resolveStackEnvPath(stackName).baseDir;
                try {
                  await stopStackWithEnv({
                    rootDir,
                    stackName,
                    baseDir,
                    env,
                    json: false,
                    noDocker: false,
                    aggressive: false,
                    sweepOwned: true,
                    preserveDaemon: true,
                  });
                } catch {
                  // ignore
                }
                // eslint-disable-next-line no-await-in-loop
                if (await isTcpPortFree(p)) {
                  continue;
                }

              }
              throw new Error(
                `[stack] ${stackName}: cannot reuse port ${p} on restart (port is not free).\n` +
                  `[stack] Fix: stop the process using it, or re-run without --restart to allocate new ports.`
              );
            }
          }
        } else {
          ports.server = await pickNextFreeTcpPort(startPort, { reservedPorts: reserved });
          reserved.add(ports.server);

          if (serverComponent === 'happier-server') {
            ports.backend = await pickNextFreeTcpPort(ports.server + 10, { reservedPorts: reserved });
            reserved.add(ports.backend);
            if (managedInfra) {
              ports.pg = await pickNextFreeTcpPort(ports.server + 1000, { reservedPorts: reserved });
              reserved.add(ports.pg);
              ports.redis = await pickNextFreeTcpPort(ports.pg + 1, { reservedPorts: reserved });
              reserved.add(ports.redis);
              ports.minio = await pickNextFreeTcpPort(ports.redis + 1, { reservedPorts: reserved });
              reserved.add(ports.minio);
              ports.minioConsole = await pickNextFreeTcpPort(ports.minio + 1, { reservedPorts: reserved });
              reserved.add(ports.minioConsole);
            }
          }
        }

        // Sanity: if somehow the server port is now occupied, fail closed (avoids killPortListeners nuking random processes).
        if (!adoptOccupiedRuntimePorts && !(await isTcpPortFree(Number(ports.server)))) {
          throw new Error(`[stack] ${stackName}: picked server port ${ports.server} but it is not free`);
        }

        const childEnv = {
          ...env,
          HAPPIER_STACK_EPHEMERAL_PORTS: '1',
          HAPPIER_STACK_SERVER_PORT: String(ports.server),
          ...(serverComponent === 'happier-server' && ports.backend
            ? {
                HAPPIER_STACK_SERVER_BACKEND_PORT: String(ports.backend),
              }
            : {}),
          ...(managedInfra && ports.pg
            ? {
                HAPPIER_STACK_PG_PORT: String(ports.pg),
                HAPPIER_STACK_REDIS_PORT: String(ports.redis),
                HAPPIER_STACK_MINIO_PORT: String(ports.minio),
                HAPPIER_STACK_MINIO_CONSOLE_PORT: String(ports.minioConsole),
              }
            : {}),
        };

        // Background dev auth flow (automatic):
        // If we're starting `dev.mjs` in background and the stack is not authenticated yet,
        // keep the stack alive for guided login by marking this as an auth-flow so URL resolution
        // fails closed (never opens server port as "UI").
        //
        // IMPORTANT:
        // We must NOT start the daemon before credentials exist in orchestrated flows (setup-pr/review-pr),
        // because the daemon can enter its own auth flow and become stranded (lock held, no machine registration).
        if (background && scriptPath === 'dev.mjs') {
          const startUi = resolveRequestedStackServeUi({ args, env });
          const startDaemon = resolveStackDaemonStartRequested({
            env,
            noDaemon: args.includes('--no-daemon'),
          });
          if (startUi && startDaemon) {
            try {
              const stackBaseDir = resolveStackEnvPath(stackName).baseDir;
              const cliHomeDir = getCliHomeDirFromEnvOrDefault({ stackBaseDir, env });
              const serverUrl = (childEnv.HAPPIER_SERVER_URL ?? env.HAPPIER_SERVER_URL ?? '').toString().trim();
              const hasCreds = Boolean(findExistingStackCredentialPath({ cliHomeDir, serverUrl, env: childEnv }));
              if (!hasCreds) {
                childEnv.HAPPIER_STACK_AUTH_FLOW = '1';
              }
            } catch {
              // If we can't resolve CLI home dir, skip auto auth-flow markers (best-effort).
            }
          }
        }

        // Background mode: send runner output to a stack-scoped log file so quiet flows can
        // remain clean while still providing actionable error logs.
        const stackBaseDir = resolveStackEnvPath(stackName).baseDir;
        const logsDir = join(stackBaseDir, 'logs');
        const launched = await withStackRuntimeStartClaim(
          runtimeStatePath,
          { stackName },
          async ({ recordStart }) => {
            const logPath = join(logsDir, `${scriptPath.replace(/\.mjs$/, '')}.${Date.now()}.log`);
            if (background) await ensureDir(logsDir);
            const logHandle = background ? await open(logPath, 'a') : null;
            const outFd = logHandle?.fd ?? null;
            const child = spawn(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], {
              cwd: rootDir,
              env: childEnv,
              stdio: background ? ['ignore', outFd ?? 'ignore', outFd ?? 'ignore'] : 'inherit',
              shell: false,
              detached: background && process.platform !== 'win32',
            });
            let startedRuntime = null;
            try {
              startedRuntime = await recordStart(createOuterStackRuntimeStartPublication({
                stackName,
                scriptPath,
                ephemeral: true,
                ownerPid: child.pid,
                ports,
                runtimeSnapshotId,
                args,
                env: childEnv,
                logs: background ? { runner: logPath } : null,
              }));
            } catch (error) {
              await terminateSpawnedRunnerForBootFailure(child, { preserveRuntimeState: true })
                .catch(() => ({ ok: false }));
              throw error;
            } finally {
              await logHandle?.close().catch(() => {});
            }
            return { child, logPath, expectedRuntimeState: startedRuntime };
          },
        );
        const { child, logPath, expectedRuntimeState } = launched;
        restartCleanupExpectedRuntimeState = expectedRuntimeState;

        if (background) {
          // Keep stack.runtime.json so stack-scoped stop/restart can manage this runner.
          // This mode is used by higher-level commands that want to run guided auth steps
          // without mixing them into server logs.
          const internalServerUrl = resolveBackgroundReadinessServerUrl({
            scriptPath,
            args,
            env: childEnv,
            localServerUrl: `http://127.0.0.1:${ports.server}`,
          });

          // Fail fast if the runner dies immediately or never exposes HTTP.
          // IMPORTANT: do not treat "some process answered /health" as success unless our runner
          // is still alive. Otherwise, if the chosen port is already in use, the runner can exit
          // and a different stack/process could satisfy the health check (leading to confusing
          // follow-on behavior like auth using the wrong port).
          try {
            let exited = null;
            const exitPromise = new Promise((resolvePromise) => {
              child.once('exit', (code, sig) => {
                exited = { kind: 'exit', code: code ?? 0, sig: sig ?? null };
                resolvePromise(exited);
              });
              child.once('error', (err) => {
                exited = { kind: 'error', error: err instanceof Error ? err.message : String(err) };
                resolvePromise(exited);
              });
            });
            const readyPromise = (async () => {
              const timeoutMsRaw = (process.env.HAPPIER_STACK_STACK_BACKGROUND_READY_TIMEOUT_MS ?? '180000').toString().trim();
              const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 180_000;
              await waitForBackgroundStackReadiness({
                stackName,
                scriptPath,
                args,
                env: childEnv,
                runtimeStatePath,
                internalServerUrl,
                expectedDaemonDistClosureFingerprint: runtimeLaunchContext.snapshot?.daemonDistClosureFingerprint ?? null,
                sourceDaemonLaunchAttempt: createSourceDaemonLaunchAttempt({
                  runtimeSnapshotId,
                  startedRuntime: expectedRuntimeState,
                  incumbentRuntime: runtimeState,
                  requireDaemonReplacement: isTrueRestart,
                }),
                timeoutMs,
                isRunnerAlive: () => isPidAlive(child.pid),
              });
              return { kind: 'ready' };
            })();

            const first = await Promise.race([exitPromise, readyPromise]);
            if (first.kind !== 'ready') {
              throw new Error(`[stack] ${stackName}: runner exited before becoming ready. log: ${logPath}`);
            }
            // Even if /health responded, ensure our runner is still alive.
            // (Prevents false positives when another process owns the port.)
            if (exited && exited.kind !== 'ready') {
              throw new Error(`[stack] ${stackName}: runner reported ready but exited immediately. log: ${logPath}`);
            }
            if (!isPidAlive(child.pid)) {
              throw new Error(
                `[stack] ${stackName}: runner health check passed, but runner is not running.\n` +
                  `[stack] This usually means the chosen port (${ports.server}) is already in use by another process.\n` +
                  `[stack] log: ${logPath}`
              );
            }
          } catch (e) {
            // Attach some log context so failures are debuggable even when a higher-level
            // command cleans up the sandbox directory afterwards.
            try {
              const tail = await readLastLines(logPath, 160);
              if (tail && e instanceof Error) {
                e.message = `${e.message}\n\n[stack] last runner log lines:\n${tail}`;
              }
            } catch {
              // ignore
            }
            await terminateSpawnedRunnerForBootFailure(child, {
              runtimeStatePath,
              expectedRuntimeState,
              preserveRuntimeState: preservedDaemonForRestart,
            }).catch(() => ({ ok: false }));
            throw e;
          }

          if (!wantsJson) {
            console.log(`[stack] ${stackName}: logs: ${logPath}`);
          }
          try {
            child.unref();
          } catch {
            // ignore
          }
          return;
        }

        let exit = { code: null, sig: null, ok: false };
        try {
          await new Promise((resolvePromise, rejectPromise) => {
            child.on('error', rejectPromise);
            child.on('exit', (code, sig) => {
              exit = { code: code ?? null, sig: sig ?? null, ok: code === 0 };
              if (code === 0) return resolvePromise();
              return rejectPromise(new Error(`stack ${scriptPath} exited (code=${code ?? 'null'}, sig=${sig ?? 'null'})`));
            });
          });
        } finally {
          const cur = await readStackRuntimeStateFile(runtimeStatePath);
          if (Number(expectedRuntimeState?.ownerPid) === Number(child.pid)) {
            // Only delete runtime state when we're confident no child processes are left behind.
            // If the runner crashes but a child (server/expo/daemon) stays alive, keeping stack.runtime.json
            // allows `hstack stack stop --aggressive` to kill the recorded PIDs safely.
            const anyAlive = getStackRuntimeProcessEntries(cur).some(({ pid }) => isPidAlive(pid));
            const portRaw = cur?.ports && typeof cur.ports === 'object' ? cur.ports.server : null;
            const port = Number(portRaw);
            const portOccupied = Number.isFinite(port) && port > 0 ? !(await isTcpPortFree(port, { host: '127.0.0.1' }).catch(() => true)) : false;

            if (!anyAlive && !portOccupied) {
              await deleteStackRuntimeStateIfOwnedBy(runtimeStatePath, expectedRuntimeState);
            } else if (!wantsJson) {
              console.warn(
                `[stack] ${stackName}: preserving ${runtimeStatePath} after runner exit (child processes still alive). ` +
                  `Run: hstack stack stop ${stackName} --yes --aggressive`
              );
            }
          }
        }
          return;
        }

        // Pinned port stack: run normally under the pinned env.
        if (background && wantsJson) {
        // Background mode is meaningless for a dry-run. Run the script normally so callers
        // can still use `--background --json` as a config probe.
        await run(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], { cwd: rootDir, env });
        return;
        }
        if (background) {
        const pinnedPort = coercePort(env.HAPPIER_STACK_SERVER_PORT);
        if (!pinnedPort) {
          throw new Error(`[stack] ${stackName}: cannot start in background (missing HAPPIER_STACK_SERVER_PORT)`);
        }

        const stackBaseDir = resolveStackEnvPath(stackName).baseDir;
        const logsDir = join(stackBaseDir, 'logs');
        const { child, logPath, expectedRuntimeState } = await withStackRuntimeStartClaim(
          runtimeStatePath,
          { stackName },
          async ({ recordStart }) => {
            const logPath = join(logsDir, `${scriptPath.replace(/\.mjs$/, '')}.${Date.now()}.log`);
            await ensureDir(logsDir);
            const logHandle = await open(logPath, 'a');
            const child = spawn(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], {
              cwd: rootDir,
              env,
              stdio: ['ignore', logHandle.fd, logHandle.fd],
              shell: false,
              detached: process.platform !== 'win32',
            });
            let startedRuntime = null;
            try {
              startedRuntime = await recordStart(createOuterStackRuntimeStartPublication({
                stackName,
                scriptPath,
                ephemeral: false,
                ownerPid: child.pid,
                ports: { server: pinnedPort },
                runtimeSnapshotId,
                args,
                env,
                logs: { runner: logPath },
              }));
            } catch (error) {
              await terminateSpawnedRunnerForBootFailure(child, { preserveRuntimeState: true })
                .catch(() => ({ ok: false }));
              throw error;
            } finally {
              await logHandle.close().catch(() => {});
            }
            return { child, logPath, expectedRuntimeState: startedRuntime };
          },
        );
        restartCleanupExpectedRuntimeState = expectedRuntimeState;

        const internalServerUrl = resolveBackgroundReadinessServerUrl({
          scriptPath,
          args,
          env,
          localServerUrl: `http://127.0.0.1:${pinnedPort}`,
        });
        try {
          let exited = null;
          const exitPromise = new Promise((resolvePromise) => {
            child.once('exit', (code, sig) => {
              exited = { kind: 'exit', code: code ?? 0, sig: sig ?? null };
              resolvePromise(exited);
            });
            child.once('error', (err) => {
              exited = { kind: 'error', error: err instanceof Error ? err.message : String(err) };
              resolvePromise(exited);
            });
          });
          const readyPromise = (async () => {
            const timeoutMsRaw = (process.env.HAPPIER_STACK_STACK_BACKGROUND_READY_TIMEOUT_MS ?? '180000').toString().trim();
            const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 180_000;
            await waitForBackgroundStackReadiness({
              stackName,
              scriptPath,
              args,
              env,
              runtimeStatePath,
              internalServerUrl,
              expectedDaemonDistClosureFingerprint: runtimeLaunchContext.snapshot?.daemonDistClosureFingerprint ?? null,
              sourceDaemonLaunchAttempt: createSourceDaemonLaunchAttempt({
                runtimeSnapshotId,
                startedRuntime: expectedRuntimeState,
                incumbentRuntime: runtimeState,
                requireDaemonReplacement: isTrueRestart,
              }),
              timeoutMs,
              isRunnerAlive: () => isPidAlive(child.pid),
            });
            return { kind: 'ready' };
          })();

          const first = await Promise.race([exitPromise, readyPromise]);
          if (first.kind !== 'ready') {
            throw new Error(`[stack] ${stackName}: runner exited before becoming ready. log: ${logPath}`);
          }
          if (exited && exited.kind !== 'ready') {
            throw new Error(`[stack] ${stackName}: runner reported ready but exited immediately. log: ${logPath}`);
          }
          if (!isPidAlive(child.pid)) {
            throw new Error(
              `[stack] ${stackName}: runner health check passed, but runner is not running.\n` +
                `[stack] This usually means the chosen port (${pinnedPort}) is already in use by another process.\n` +
                `[stack] log: ${logPath}`
            );
          }
        } catch (e) {
          try {
            const tail = await readLastLines(logPath, 160);
            if (tail && e instanceof Error) {
              e.message = `${e.message}\n\n[stack] last runner log lines:\n${tail}`;
            }
          } catch {
            // ignore
          }
          await terminateSpawnedRunnerForBootFailure(child, {
            runtimeStatePath,
            expectedRuntimeState,
            preserveRuntimeState: preservedDaemonForRestart,
          }).catch(() => ({ ok: false }));
          throw e;
        }

        if (!wantsJson) {
          console.log(`[stack] ${stackName}: logs: ${logPath}`);
        }
        try {
          child.unref();
        } catch {
          // ignore
        }
        return;
        }
        if (isTrueRestart && !wantsJson) {
        const pinnedPort = coercePort(env.HAPPIER_STACK_SERVER_PORT);
        if (pinnedPort && !(await isTcpPortFree(pinnedPort))) {
          throw new Error(
            `[stack] ${stackName}: server port ${pinnedPort} is not free on restart.\n` +
              `[stack] Refusing to kill listeners selected by port. Stop the process using it, or change the pinned port.`
          );
        }
        }
        await run(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], { cwd: rootDir, env });
      } catch (error) {
        if (preservedDaemonForRestart) {
          await cleanupFailedRestartAttempt({
            rootDir,
            stackName,
            baseDir,
            env,
            runtimeStatePath,
            expectedRuntimeState: restartCleanupExpectedRuntimeState,
            wantsJson,
          });
        }
        throw error;
      }
    },
  });
}
