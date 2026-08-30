import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { ensureCliBuilt } from '../proc/pm.mjs';
import {
  isDevRuntimeReloadIgnoredPath,
  readDevReloadWatchChangeSignature,
  readDevReloadWatchChangeSignatureAsync,
} from './devReloadCoordinator.mjs';
import { getAccountCountForServerComponent, prepareDaemonAuthSeedIfNeeded } from '../stack/startup.mjs';
import { startLocalDaemonWithAuth } from '../../daemon.mjs';
import {
  isDaemonControlRestartUnavailableError,
  pingDaemon,
  restartDaemonViaControlServer,
} from '../stack/daemonControlClient.mjs';
import {
  normalizeDaemonPid,
  normalizeDaemonPidList,
  syncStackRuntimeDaemonPidFromDaemonState,
} from '../stack/runtime_daemon_state.mjs';
import { isPidAlive, readStackRuntimeStateFile } from '../stack/runtime_state.mjs';
import { resolveHappyCliRuntimeInputGroups } from '../proc/cli_runtime_inputs.mjs';
import { readCliDistBuildManifest } from '../cli/cliDistIntegrity.mjs';
import { WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE } from '../proc/cliDistBuildLock.mjs';

const DAEMON_CONTROL_PUBLICATION_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000];

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createHappyCliReloadDescriptors({
  cliDir,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
  logger = console,
} = {}) {
  const groups = resolveHappyCliRuntimeInputGroups({
    cliDir,
    existsSyncImpl,
    readFileSyncImpl,
    logger,
  });
  return groups.map((group) => ({
    ...group,
    readSignature: () => readHappyCliWatchChangeSignature(group.paths),
    readSignatureAsync: () => readHappyCliWatchChangeSignatureAsync(group.paths),
  }));
}

function readHappyCliWatchChangeSignature(paths) {
  return readDevReloadWatchChangeSignature(paths, { ignorePath: isDevRuntimeReloadIgnoredPath });
}

function readHappyCliWatchChangeSignatureAsync(paths) {
  return readDevReloadWatchChangeSignatureAsync(paths, { ignorePath: isDevRuntimeReloadIgnoredPath });
}

function collectRuntimeDaemonPids(runtimeState) {
  const pids = [];
  const add = (value) => {
    const pid = normalizeDaemonPid(value);
    if (pid && !pids.includes(pid)) pids.push(pid);
  };
  add(runtimeState?.processes?.daemonPid);
  for (const value of normalizeDaemonPidList(runtimeState?.processes?.daemonPids)) {
    add(value);
  }
  return pids;
}

function resolveCliDistBuildManifestPath(cliDir) {
  return join(cliDir, 'dist', '.build-manifest.json');
}

function hasCliDistBuildOutput(cliDir, existsSyncImpl = existsSync) {
  return existsSyncImpl(join(cliDir, 'dist', 'index.mjs')) && existsSyncImpl(resolveCliDistBuildManifestPath(cliDir));
}

async function hasLiveRuntimeDaemonPid({
  runtimeStatePath,
}, {
  readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
  isPidAliveImpl = isPidAlive,
} = {}) {
  const statePath = String(runtimeStatePath ?? '').trim();
  if (!statePath) return false;
  let runtimeState = null;
  try {
    runtimeState = await readStackRuntimeStateFileImpl(statePath);
  } catch {
    runtimeState = null;
  }
  return collectRuntimeDaemonPids(runtimeState).some((pid) => isPidAliveImpl(pid));
}

function normalizeDistClosureFingerprint(value) {
  const fingerprint = String(value ?? '').trim().toLowerCase();
  return /^[a-f0-9]{16}$/.test(fingerprint) ? fingerprint : null;
}

async function isCandidateDistAlreadyActive({
  ping,
  successorDistClosureFingerprint,
  runtimeStatePath,
}, {
  readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
} = {}) {
  const candidateFingerprint = normalizeDistClosureFingerprint(successorDistClosureFingerprint);
  const activeFingerprint = normalizeDistClosureFingerprint(ping?.distClosureFingerprint);
  const activePid = normalizeDaemonPid(ping?.pid);
  const statePath = String(runtimeStatePath ?? '').trim();
  if (
    ping?.ok !== true
    || !candidateFingerprint
    || activeFingerprint !== candidateFingerprint
    || !activePid
    || !statePath
  ) {
    return false;
  }

  let runtimeState = null;
  try {
    runtimeState = await readStackRuntimeStateFileImpl(statePath);
  } catch {
    return false;
  }
  return normalizeDaemonPid(runtimeState?.processes?.daemonPid) === activePid
    && normalizeDistClosureFingerprint(runtimeState?.daemon?.distClosureFingerprint)
      === candidateFingerprint;
}

async function shouldColdStartAfterDaemonControlMiss({
  ping,
  runtimeStatePath,
}, {
  readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
  isPidAliveImpl = isPidAlive,
} = {}) {
  if (ping?.ok === true) return false;
  const reason = String(ping?.reason ?? '').trim();
  if (reason === 'daemon_not_running') return true;
  if (normalizeDaemonPid(ping?.pid)) return false;
  if (await hasLiveRuntimeDaemonPid(
    { runtimeStatePath },
    { readStackRuntimeStateFileImpl, isPidAliveImpl },
  )) {
    return false;
  }
  return reason === 'missing_state';
}

export async function prepareDaemonAuthSeed({
  rootDir,
  env,
  stackName,
  cliHomeDir,
  startDaemon,
  isInteractive,
  serverComponentName,
  serverDir,
  serverEnv,
  quiet = false,
}) {
  if (!startDaemon) return { ok: true, skipped: true, reason: 'no_daemon' };
  const acct = await getAccountCountForServerComponent({
    serverComponentName,
    serverDir,
    env: serverEnv,
    // This probe is used only for auth seeding heuristics (and should never block stack startup).
    // For server-light (embedded PGlite), avoid doing anything that could fight for the single-connection DB.
    bestEffort: true,
  });
  return await prepareDaemonAuthSeedIfNeeded({
    rootDir,
    env,
    stackName,
    cliHomeDir,
    startDaemon,
    isInteractive,
    accountCount: typeof acct.accountCount === 'number' ? acct.accountCount : null,
    quiet,
    // IMPORTANT: run auth seeding under the same env used for server probes (includes DATABASE_URL).
    authEnv: serverEnv,
  });
}

export async function startDevDaemon({
  startDaemon,
  cliBin,
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  runtimeStatePath = null,
  restart,
  startLastGreen = false,
  keepServerRunningOnFailure = false,
  isShuttingDown,
  env = process.env,
  stackName = null,
  cliIdentity = 'default',
}, {
  startLocalDaemonWithAuthImpl = startLocalDaemonWithAuth,
  logger = console,
} = {}) {
  if (!startDaemon) return { started: false, reason: 'daemon-disabled' };

  try {
    await startLocalDaemonWithAuthImpl({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown,
      forceRestart: Boolean(restart),
      admitPriorDistImmediately: Boolean(startLastGreen),
      env,
      stackName,
      cliIdentity,
    });
    return { started: true };
  } catch (error) {
    if (!startLastGreen && !keepServerRunningOnFailure) throw error;
    if (keepServerRunningOnFailure && !startLastGreen) {
      logger.warn(
        '[local] daemon startup failed; keeping the TUI server running so daemon recovery can be retried. ' +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
      return {
        started: false,
        reason: 'daemon-start-failed',
      };
    }
    logger.warn(
      '[local] daemon: the last-green CLI publication could not start; ' +
        'continuing startup so the watch coordinator can repair it with a background rebuild. ' +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
    return {
      started: false,
      reason: 'prior-dist-start-failed',
    };
  }
}

export function createHappyCliReloadExecutor({
  startDaemon,
  buildCli,
  cliDir,
  cliBin,
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  runtimeStatePath = null,
  isShuttingDown,
  env = process.env,
  stackName = null,
  cliIdentity = 'default',
}, {
  ensureCliBuiltImpl = ensureCliBuilt,
  startLocalDaemonWithAuthImpl = startLocalDaemonWithAuth,
  pingDaemonImpl = pingDaemon,
  restartDaemonViaControlServerImpl = restartDaemonViaControlServer,
  syncStackRuntimeDaemonPidFromDaemonStateImpl = syncStackRuntimeDaemonPidFromDaemonState,
  readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
  isPidAliveImpl = isPidAlive,
  existsSyncImpl = existsSync,
  sleepImpl = sleepMs,
  logger = console,
} = {}) {
  let successorDistClosureFingerprint = null;
  let successorPublicationSuperseded = false;
  let successorActivationMayOutliveGeneration = false;
  return {
    target: 'daemon',
    async build(context = {}) {
      successorDistClosureFingerprint = null;
      successorPublicationSuperseded = false;
      successorActivationMayOutliveGeneration = false;
      if (!startDaemon) {
        logger.warn('[local] watch: happier-cli reload skipped (daemon-disabled).');
        return { skipped: true, reason: 'daemon-disabled' };
      }
      logger.log('[local] watch: happier-cli changed → rebuilding + restarting daemon...');
      let buildResult;
      for (;;) {
        try {
          buildResult = await ensureCliBuiltImpl(cliDir, { buildCli, env });
          break;
        } catch (error) {
          if (
            error?.code !== WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE
            || typeof context.revalidateGeneration !== 'function'
          ) {
            throw error;
          }
          if (!await context.revalidateGeneration()) {
            return { skipped: true, reason: 'stale-generation' };
          }
          logger.warn(
            '[local] watch: the shared happier-cli build is still active; ' +
              'continuing to wait so this Stack can adopt its publication.',
          );
        }
      }

      const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
      const distManifest = resolveCliDistBuildManifestPath(cliDir);
      if (!hasCliDistBuildOutput(cliDir, existsSyncImpl)) {
        throw new Error(
          `[local] watch: happier-cli build did not produce ${distEntrypoint} and build manifest ${distManifest}; refusing to restart daemon to avoid downtime.`
        );
      }
      const distClosure = readCliDistBuildManifest(distEntrypoint);
      if (!distClosure.ok || !distClosure.fingerprint) {
        throw new Error(
          `[local] watch: happier-cli build manifest is invalid (${distClosure.reason}); refusing to restart daemon to avoid runtime fingerprint drift.`
        );
      }
      const adoptedConcurrentPublication = (
        buildResult?.reason === 'concurrent_build_already_completed'
        || buildResult?.reason === 'concurrent_build_superseded'
      );
      if (buildResult?.current !== true) {
        if (buildResult?.built === true || adoptedConcurrentPublication) {
          successorDistClosureFingerprint = distClosure.fingerprint;
          successorPublicationSuperseded = true;
          successorActivationMayOutliveGeneration = true;
          logger.warn(
            '[local] watch: happier-cli published or adopted a runnable build that newer edits already superseded; ' +
              'activating it now while the reload coordinator builds the trailing latest generation.'
          );
          return { ok: true, allowSupersededActivation: true };
        }
        logger.warn(
          `[local] watch: happier-cli rebuild skipped (${buildResult.reason ?? 'unknown'}); keeping the current daemon running.`
        );
        return { skipped: true, reason: `cli-build-${buildResult.reason ?? 'unknown'}` };
      }
      successorDistClosureFingerprint = distClosure.fingerprint;
      successorActivationMayOutliveGeneration = (
        buildResult?.built === true
        || adoptedConcurrentPublication
      );
      return {
        ok: true,
        ...(successorActivationMayOutliveGeneration
          ? { allowSupersededActivation: true }
          : {}),
      };
    },
    async restart(context = {}) {
      if (!startDaemon || isShuttingDown?.()) return { skipped: true, reason: 'daemon-disabled' };
      const generationIsCurrent = async () =>
        typeof context.revalidateGeneration !== 'function' || context.revalidateGeneration();
      const coldStart = async () => {
        if (!successorActivationMayOutliveGeneration && !await generationIsCurrent()) {
          return { skipped: true, reason: 'stale-generation' };
        }
        if (successorPublicationSuperseded) {
          logger.warn(
            '[local] watch: daemon is absent; starting the runnable superseded happier-cli publication in degraded mode ' +
              'while the existing reload coordinator builds the trailing latest generation.'
          );
        }
        await startLocalDaemonWithAuthImpl({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          runtimeStatePath,
          isShuttingDown,
          forceRestart: false,
          preserveExistingRunning: true,
          env,
          stackName,
          cliIdentity,
          admittedDistClosureFingerprint: successorDistClosureFingerprint,
        });
        return {
          restarted: true,
          mode: 'cold-start',
          ...(successorPublicationSuperseded ? { degraded: true } : {}),
        };
      };
      let ping = await pingDaemonImpl({
        cliHomeDir,
        serverUrl: internalServerUrl,
        internalServerUrl,
        env,
        stackName,
      });
      if (
        ping?.ok !== true
        && successorDistClosureFingerprint
        && await hasLiveRuntimeDaemonPid(
          { runtimeStatePath },
          { readStackRuntimeStateFileImpl, isPidAliveImpl },
        )
      ) {
        for (const delayMs of DAEMON_CONTROL_PUBLICATION_RETRY_DELAYS_MS) {
          if (isShuttingDown?.()) return { skipped: true, reason: 'daemon-disabled' };
          await sleepImpl(delayMs);
          ping = await pingDaemonImpl({
            cliHomeDir,
            serverUrl: internalServerUrl,
            internalServerUrl,
            env,
            stackName,
          });
          if (ping?.ok === true) break;
        }
      }
      if (ping?.ok === true) {
        if (await isCandidateDistAlreadyActive(
          { ping, successorDistClosureFingerprint, runtimeStatePath },
          { readStackRuntimeStateFileImpl },
        )) {
          logger.log(
            '[local] watch: the healthy daemon already runs the current happier-cli dist; skipping restart.',
          );
          return { skipped: true, reason: 'daemon-dist-already-active' };
        }
        if (!successorActivationMayOutliveGeneration && !await generationIsCurrent()) {
          return { skipped: true, reason: 'stale-generation' };
        }
        let replacement;
        try {
          replacement = await restartDaemonViaControlServerImpl({
            cliHomeDir,
            internalServerUrl,
            env,
            stackName,
            successorDistClosureFingerprint,
          });
        } catch (error) {
          if (!isDaemonControlRestartUnavailableError(error)) {
            throw error;
          }
          logger.warn('[local] watch: daemon control /restart is unavailable; keeping the current daemon running.');
          return { skipped: true, reason: 'daemon-control-restart-unavailable' };
        }
        if (replacement?.status !== 'restarting' && replacement?.status !== 'already_restarting') {
          throw new Error('[local] watch: daemon control restart did not return an owned replacement');
        }
        const successorPid = normalizeDaemonPid(replacement.pid);
        if (!successorPid) {
          throw new Error('[local] watch: daemon control restart did not confirm a successor pid');
        }
        if (runtimeStatePath) {
            const successorObservation = {
              status: 'running',
              pid: successorPid,
              ...(replacement.processInstanceFingerprint
                ? { processInstanceFingerprint: replacement.processInstanceFingerprint }
                : {}),
              distClosureFingerprint: successorDistClosureFingerprint,
            };
          await syncStackRuntimeDaemonPidFromDaemonStateImpl(
            {
              runtimeStatePath,
              cliHomeDir,
              internalServerUrl,
              runtimeDaemonPid: successorPid,
              authenticatedProcessInstanceFingerprint:
                replacement.processInstanceFingerprint ?? null,
              env,
              daemonDistFingerprint: successorDistClosureFingerprint,
            },
            { checkDaemonStateImpl: async () => successorObservation },
          );
        }
        return { restarted: true, mode: 'overlap' };
      }

      const canColdStart = await shouldColdStartAfterDaemonControlMiss(
        { ping, runtimeStatePath },
        { readStackRuntimeStateFileImpl, isPidAliveImpl },
      );
      if (!canColdStart) {
        logger.warn(
          `[local] watch: daemon control is unavailable (${ping?.reason ?? 'unknown'}); keeping the current daemon running.`
        );
        return { skipped: true, reason: `daemon-control-unavailable:${ping?.reason ?? 'unknown'}` };
      }
      return await coldStart();
    },
  };
}
