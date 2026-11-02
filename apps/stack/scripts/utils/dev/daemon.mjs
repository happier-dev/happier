import { existsSync } from 'node:fs';

import { syncSharedDepsForSourceDev } from '../proc/pm.mjs';
import { getAccountCountForServerComponent, prepareDaemonAuthSeedIfNeeded } from '../stack/startup.mjs';
import { startLocalDaemonWithAuth } from '../../daemon.mjs';
import {
  readDevReloadWatchChangeSignature,
  readDevReloadWatchChangeSignatureAsync,
} from './devReloadCoordinator.mjs';
import {
  isDaemonControlRestartUnavailableError,
  pingDaemon,
} from '../stack/daemonControlClient.mjs';
import {
  normalizeDaemonPid,
  normalizeDaemonPidList,
} from '../stack/runtime_daemon_state.mjs';
import { isPidAlive, readStackRuntimeStateFile } from '../stack/runtime_state.mjs';
import { resolveHappyCliRuntimeInputGroups } from '../proc/cli_runtime_inputs.mjs';

const inFlightDevDaemonStarts = new Map();

/**
 * The dev daemon runs the same moving-source bundle the Stack source runtime uses
 * (`buildSourceRuntimeBundle`, esbuild, no whole-package typecheck, no CLI dist
 * publication). It is selected and recorded through the existing
 * `sourceRuntimeLaunchUpdate` seam of `startLocalDaemonWithAuth`.
 *
 * `reuseSelected: true` reads only the retained generation and never compiles or
 * waits on a build, dependency or admission lock, so startup and recovery cannot be
 * held up by other sessions; with no retained generation it throws and the reload
 * coordinator's first build supplies one. The default builds current source.
 */
export async function prepareDevDaemonSourceRuntime({
  sourceRuntimeOptions,
  env = process.env,
  reuseSelected = false,
}, {
  buildSourceRuntimeBundleImpl = async (options) => (
    await import('../../build/build_source_runtime.mjs')
  ).buildSourceRuntimeBundle(options),
  logger = console,
} = {}) {
  logger.log(`[local] daemon: preparing ${reuseSelected ? 'retained' : 'current'} source generation`);
  const built = await buildSourceRuntimeBundleImpl({
    ...sourceRuntimeOptions,
    component: 'daemon',
    env,
    devStartup: true,
    reuseSelected,
    waitForSourceChanges: false,
  });
  logger.log(`[local] daemon: ${built.lastGreen ? 'retained' : 'captured'} source generation ${built.identity} ready`);
  return {
    launch: { entrypoint: built.entrypoint, cliDir: built.cliDir, env: built.env ?? {} },
    identity: built.identity,
  };
}

export function createHappyCliReloadDescriptors({ cliDir, existsSyncImpl = existsSync } = {}) {
  return resolveHappyCliRuntimeInputGroups({ cliDir, existsSyncImpl }).map((group) => ({
    ...group,
    readSignature: () => readHappyCliWatchChangeSignature(group.paths),
    readSignatureAsync: (_descriptor, options) => readHappyCliWatchChangeSignatureAsync(group.paths, options),
  }));
}

export function createHappyCliWorkspacePreparationExecutor({
  repoRoot,
  cliDir,
  env = process.env,
}, {
  syncSharedDepsForSourceDevImpl = syncSharedDepsForSourceDev,
} = {}) {
  let inFlightBuild = null;
  return {
    target: 'daemon',
    build() {
      if (inFlightBuild) return inFlightBuild;
      const build = Promise.resolve().then(async () => (
        await syncSharedDepsForSourceDevImpl(repoRoot, {
          cliDir,
          env,
          quiet: true,
        })
      ));
      const settledBuild = build.finally(() => {
        if (inFlightBuild === settledBuild) inFlightBuild = null;
      });
      inFlightBuild = settledBuild;
      return settledBuild;
    },
    async restart() {
      return { skipped: true, reason: 'preparation-only' };
    },
  };
}

function readHappyCliWatchChangeSignature(paths) {
  return readDevReloadWatchChangeSignature(paths);
}

function readHappyCliWatchChangeSignatureAsync(paths, options) {
  return readDevReloadWatchChangeSignatureAsync(paths, options);
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
  preserveExistingRunning = false,
  isShuttingDown,
  env = process.env,
  stackName = null,
  cliIdentity = 'default',
  sourceRuntimeOptions,
}, {
  prepareDevDaemonSourceRuntimeImpl = prepareDevDaemonSourceRuntime,
  startLocalDaemonWithAuthImpl = startLocalDaemonWithAuth,
  logger = console,
} = {}) {
  if (!startDaemon) return { started: false, reason: 'daemon-disabled' };

  try {
    const scope = JSON.stringify([cliHomeDir, internalServerUrl, stackName, cliIdentity]);
    for (;;) {
      let active = inFlightDevDaemonStarts.get(scope);
      if (!active) {
        const start = Promise.resolve().then(async () => {
          // Startup and recovery boot the retained generation. An explicit
          // restart prepares current source before the canonical lifecycle
          // owner replaces the daemon, including stale installed dependencies.
          const sourceRuntimeLaunchUpdate = await prepareDevDaemonSourceRuntimeImpl({
            sourceRuntimeOptions,
            env,
            reuseSelected: !restart,
          });
          return await startLocalDaemonWithAuthImpl({
            cliBin,
            cliHomeDir,
            internalServerUrl,
            publicServerUrl,
            runtimeStatePath,
            isShuttingDown,
            forceRestart: Boolean(restart),
            preserveExistingRunning: Boolean(preserveExistingRunning),
            env,
            stackName,
            cliIdentity,
            sourceRuntimeLaunchUpdate,
          });
        }).finally(() => {
          if (inFlightDevDaemonStarts.get(scope)?.start === start) inFlightDevDaemonStarts.delete(scope);
        });
        active = { start, forceRestart: Boolean(restart) };
        inFlightDevDaemonStarts.set(scope, active);
      }
      if (restart && !active.forceRestart) {
        await active.start.catch(() => undefined);
        continue;
      }
      await active.start;
      break;
    }
    return { started: true };
  } catch (error) {
    if (error?.code === 'source_bundle_unavailable') {
      // No daemon generation has been built for this Stack yet. The reload
      // coordinator's initial daemon refresh is building one and cold-starts the
      // daemon when it lands; restarting the Stack would only restart that build.
      logger.warn(
        '[local] daemon: the first daemon build is running in the background; the daemon starts as soon as it is ready. ' +
          'Keep the stack running: a restart starts that build over.',
      );
      return { started: false, reason: 'daemon-awaiting-first-build' };
    }
    logger.warn(
      '[local] daemon startup failed; keeping the stack running so daemon recovery or the next source reload can retry. ' +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
    return { started: false, reason: 'daemon-start-failed' };
  }
}

export function createHappyCliReloadExecutor({
  startDaemon,
  cliBin,
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  runtimeStatePath = null,
  isShuttingDown,
  env = process.env,
  stackName = null,
  cliIdentity = 'default',
  sourceRuntimeOptions,
}, {
  prepareDevDaemonSourceRuntimeImpl = prepareDevDaemonSourceRuntime,
  startLocalDaemonWithAuthImpl = startLocalDaemonWithAuth,
  pingDaemonImpl = pingDaemon,
  readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
  isPidAliveImpl = isPidAlive,
  logger = console,
} = {}) {
  let successor = null;
  const readLoadedIdentity = async () => {
    if (!runtimeStatePath) return null;
    try {
      return (await readStackRuntimeStateFileImpl(runtimeStatePath))?.sourceRuntimeIdentities?.daemon?.loaded ?? null;
    } catch {
      return null;
    }
  };
  const launchSuccessor = (overrides) => startLocalDaemonWithAuthImpl({
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    runtimeStatePath,
    isShuttingDown,
    env,
    stackName,
    cliIdentity,
    sourceRuntimeLaunchUpdate: successor,
    ...overrides,
  });
  return {
    target: 'daemon',
    async build() {
      if (!startDaemon) return { skipped: true, reason: 'daemon-disabled' };
      successor = null;
      logger.log('[local] watch: happier-cli changed → preparing the daemon source generation...');
      successor = await prepareDevDaemonSourceRuntimeImpl({ sourceRuntimeOptions, env });
      const ping = await pingDaemonImpl({
        cliHomeDir,
        serverUrl: internalServerUrl,
        internalServerUrl,
        env,
        stackName,
      });
      // A recorded loaded identity can outlive its daemon. Use the same absence
      // decision as cold-start activation while the trailing build catches up.
      const canColdStart = await shouldColdStartAfterDaemonControlMiss(
        { ping, runtimeStatePath },
        { readStackRuntimeStateFileImpl, isPidAliveImpl },
      );
      return canColdStart
        ? { ok: true, allowSupersededActivation: true }
        : { ok: true };
    },
    async restart() {
      if (!startDaemon || isShuttingDown?.()) return { skipped: true, reason: 'daemon-disabled' };
      if (!successor) return { skipped: true, reason: 'no-prepared-source' };

      const ping = await pingDaemonImpl({
        cliHomeDir,
        serverUrl: internalServerUrl,
        internalServerUrl,
        env,
        stackName,
      });
      if (ping?.ok === true) {
        if (await readLoadedIdentity() === successor.identity) {
          logger.log('[local] watch: the healthy daemon already runs the current source generation; skipping restart.');
          return { skipped: true, reason: 'daemon-source-already-active' };
        }
        try {
          await launchSuccessor({
            forceRestart: true,
            // Session runners survive a source reload. The control restart needs the
            // Stack runtime state to select and attest the successor launch.
            preserveSessionsOnRestart: Boolean(runtimeStatePath),
          });
        } catch (error) {
          if (!isDaemonControlRestartUnavailableError(error)) throw error;
          logger.warn('[local] watch: daemon control /restart is unavailable; keeping the current daemon running.');
          return { skipped: true, reason: 'daemon-control-restart-unavailable' };
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
      await launchSuccessor({ forceRestart: false, preserveExistingRunning: true });
      return { restarted: true, mode: 'cold-start' };
    },
  };
}
