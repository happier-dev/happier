import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { ensureCliBuilt, ensureDepsInstalled } from '../proc/pm.mjs';
import { readCliDistIntegrity } from '../cli/cliDistIntegrity.mjs';
import { watchDebounced } from '../proc/watch.mjs';
import { getAccountCountForServerComponent, prepareDaemonAuthSeedIfNeeded } from '../stack/startup.mjs';
import { startLocalDaemonWithAuth } from '../../daemon.mjs';
import {
  readDevReloadWatchChangeSignature,
  resolveDevReloadPollIntervalMs,
  startDevReloadCoordinator,
} from './devReloadCoordinator.mjs';
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

export function createHappyCliReloadDescriptors({ cliDir, existsSyncImpl = existsSync } = {}) {
  const repoRoot = resolve(cliDir, '..', '..');
  const sharedPackages = ['agents', 'cli-common', 'protocol'];
  const cliPaths = [
    join(cliDir, 'src'),
    join(cliDir, 'bin'),
    join(cliDir, 'codex'),
    join(cliDir, 'package.json'),
    join(cliDir, 'tsconfig.json'),
    join(cliDir, 'tsconfig.build.json'),
    join(cliDir, 'pkgroll.config.mjs'),
  ];
  const makeDescriptor = (id, target, paths) => {
    const existingPaths = paths.filter((p) => existsSyncImpl(p));
    return {
      id,
      target,
      paths: existingPaths,
      readSignature: () => readHappyCliWatchChangeSignature(existingPaths),
    };
  };

  return [
    makeDescriptor('daemon:cli', 'daemon', cliPaths),
    ...sharedPackages.map((pkg) => makeDescriptor(
      `shared:${pkg}`,
      'shared',
      [
        join(repoRoot, 'packages', pkg, 'src'),
        join(repoRoot, 'packages', pkg, 'package.json'),
        join(repoRoot, 'packages', pkg, 'tsconfig.json'),
      ],
    )),
  ].filter((descriptor) => descriptor.paths.length > 0);
}

function resolveHappyCliWatchPaths({ cliDir, existsSyncImpl = existsSync }) {
  return createHappyCliReloadDescriptors({ cliDir, existsSyncImpl }).flatMap((descriptor) => descriptor.paths);
}

function readHappyCliWatchChangeSignature(paths) {
  return readDevReloadWatchChangeSignature(paths);
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

function assertCliDistBuildManifest(distEntrypoint) {
  const integrity = readCliDistIntegrity(distEntrypoint);
  if (!integrity.ok) {
    throw new Error(`[local] happier-cli build manifest is missing or invalid for ${distEntrypoint}: ${integrity.reason}`);
  }
}

export async function ensureDevCliReady(
  { cliDir, buildCli, env = process.env },
  { logger = console } = {}
) {
  await ensureDepsInstalled(cliDir, 'happier-cli', { env });
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');

  const keepExistingDistOnBuildFailure = (error) => {
    if (!existsSync(distEntrypoint)) return null;
    const msg = error instanceof Error ? error.stack || error.message : String(error);
    logger.warn(
      `[local] happier-cli build failed; keeping previous build output at ${distEntrypoint}.`
    );
    logger.warn(msg);
    return { built: false, reason: 'build_failed_using_existing_dist' };
  };

  let res;
  try {
    res = await ensureCliBuilt(cliDir, { buildCli, env });
  } catch (error) {
    const fallback = keepExistingDistOnBuildFailure(error);
    if (fallback) return fallback;
    throw error;
  }

  // Fail closed: dev mode must never start the daemon without a usable happier-cli build output.
  // Even if the user disabled CLI builds globally (or build mode is "never"), missing dist will
  // cause an immediate MODULE_NOT_FOUND crash when spawning the daemon.
  if (!existsSync(distEntrypoint)) {
    // Last-chance recovery: force a build once.
    try {
      await ensureCliBuilt(cliDir, { buildCli: true, env });
    } catch (error) {
      const fallback = keepExistingDistOnBuildFailure(error);
      if (fallback) return fallback;
      throw error;
    }
    if (!existsSync(distEntrypoint)) {
      throw new Error(
        `[local] happier-cli build output is missing.\n` +
          `Expected: ${distEntrypoint}\n` +
          `Fix: run the component build directly and inspect its output:\n` +
          `  cd "${cliDir}" && yarn build`
      );
    }
  }
  assertCliDistBuildManifest(distEntrypoint);

  return res;
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
  isShuttingDown,
  env = process.env,
  stackName = null,
  cliIdentity = 'default',
}, {
  startLocalDaemonWithAuthImpl = startLocalDaemonWithAuth,
} = {}) {
  if (!startDaemon) return;

  await startLocalDaemonWithAuthImpl({
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    runtimeStatePath,
    isShuttingDown,
    forceRestart: Boolean(restart),
    env,
    stackName,
    cliIdentity,
  });
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
  logger = console,
} = {}) {
  return {
    target: 'daemon',
    async build() {
      if (!startDaemon) return { skipped: true, reason: 'daemon-disabled' };
      logger.log('[local] watch: happier-cli changed → rebuilding + restarting daemon...');
      await ensureCliBuiltImpl(cliDir, { buildCli });

      const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
      if (!existsSyncImpl(distEntrypoint)) {
        throw new Error(
          `[local] watch: happier-cli build did not produce ${distEntrypoint}; refusing to restart daemon to avoid downtime.`
        );
      }
      const manifestPath = join(cliDir, 'dist', '.build-manifest.json');
      if (!existsSyncImpl(manifestPath)) {
        throw new Error(
          `[local] watch: happier-cli build manifest is missing (${manifestPath}); refusing to restart daemon to avoid downtime.`
        );
      }
      return { ok: true };
    },
    async restart() {
      if (!startDaemon || isShuttingDown?.()) return { skipped: true, reason: 'daemon-disabled' };
      const coldStart = async () => {
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
        });
        return { restarted: true, mode: 'cold-start' };
      };

      const ping = await pingDaemonImpl({
        cliHomeDir,
        serverUrl: internalServerUrl,
        internalServerUrl,
        env,
        stackName,
      });
      if (ping?.ok === true) {
        try {
          await restartDaemonViaControlServerImpl({
            cliHomeDir,
            internalServerUrl,
            env,
            stackName,
          });
        } catch (error) {
          if (!isDaemonControlRestartUnavailableError(error)) throw error;
          logger.warn('[local] watch: daemon control /restart is unavailable; keeping the current daemon running.');
          return { skipped: true, reason: 'daemon-control-restart-unavailable' };
        }
        if (runtimeStatePath) {
          await syncStackRuntimeDaemonPidFromDaemonStateImpl({
            runtimeStatePath,
            cliHomeDir,
            internalServerUrl,
            env,
          });
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

export function watchHappyCliAndRestartDaemon({
  enabled,
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
  watchDebouncedImpl = watchDebounced,
  ensureCliBuiltImpl = ensureCliBuilt,
  startLocalDaemonWithAuthImpl = startLocalDaemonWithAuth,
  pingDaemonImpl = pingDaemon,
  restartDaemonViaControlServerImpl = restartDaemonViaControlServer,
  syncStackRuntimeDaemonPidFromDaemonStateImpl = syncStackRuntimeDaemonPidFromDaemonState,
  readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
  isPidAliveImpl = isPidAlive,
  readWatchChangeSignatureImpl = readHappyCliWatchChangeSignature,
  existsSyncImpl = existsSync,
  logger = console,
} = {}) {
  if (!enabled || !startDaemon) return null;

  let inFlight = false;
  let pending = false;

  // IMPORTANT:
  // Watch only source/config paths, not build outputs. Watching the whole repo can
  // trigger rebuild loops because `yarn build` writes to `dist/` (and may touch other
  // generated files), which then retriggers the watcher.
  const watchPaths = resolveHappyCliWatchPaths({ cliDir, existsSyncImpl });
  let lastWatchSignature = readWatchChangeSignatureImpl(watchPaths);

  const hasRealWatchedChange = () => {
    const nextWatchSignature = readWatchChangeSignatureImpl(watchPaths);
    if (lastWatchSignature && nextWatchSignature && nextWatchSignature === lastWatchSignature) {
      return false;
    }
    if (nextWatchSignature) {
      lastWatchSignature = nextWatchSignature;
    }
    return true;
  };

  return watchDebouncedImpl({
    paths: (watchPaths.length ? watchPaths : [cliDir]).map((p) => resolve(p)),
    debounceMs: 500,
    readSignature: () => readWatchChangeSignatureImpl(watchPaths),
    pollIntervalMs: resolveDevReloadPollIntervalMs(env),
    onChange: async () => {
      if (isShuttingDown?.()) return;
      if (!hasRealWatchedChange()) return;
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      try {
        do {
          pending = false;
          if (isShuttingDown?.()) return;

          logger.log('[local] watch: happier-cli changed → rebuilding + restarting daemon...');
          try {
            await ensureCliBuiltImpl(cliDir, { buildCli });
          } catch (e) {
            // IMPORTANT:
            // - A rebuild can legitimately fail while an agent is mid-edit (e.g. TS errors).
            // - In that case we must NOT restart the daemon (we'd just restart into a broken build),
            //   and we must NOT crash the parent dev process. Keep watching for the next change.
            const msg = e instanceof Error ? e.stack || e.message : String(e);
            logger.error('[local] watch: happier-cli rebuild failed; keeping daemon running (will retry on next change).');
            logger.error(msg);
            if (pending) continue;
            break;
          }

          const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
          if (!existsSyncImpl(distEntrypoint)) {
            logger.warn(
              `[local] watch: happier-cli build did not produce ${distEntrypoint}; refusing to restart daemon to avoid downtime.`
            );
            if (pending) continue;
            break;
          }

          const coldStart = async () => {
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
            });
          };

          try {
            const ping = await pingDaemonImpl({
              cliHomeDir,
              serverUrl: internalServerUrl,
              internalServerUrl,
              env,
              stackName,
            });
            if (ping?.ok === true) {
              try {
                await restartDaemonViaControlServerImpl({
                  cliHomeDir,
                  internalServerUrl,
                  env,
                  stackName,
                });
              } catch (e) {
                if (!isDaemonControlRestartUnavailableError(e)) {
                  throw e;
                }
                logger.warn('[local] watch: daemon control /restart is unavailable; keeping the current daemon running.');
                if (pending) continue;
                break;
              }
              if (runtimeStatePath) {
                await syncStackRuntimeDaemonPidFromDaemonStateImpl({
                  runtimeStatePath,
                  cliHomeDir,
                  internalServerUrl,
                  env,
                });
              }
            } else {
              const canColdStart = await shouldColdStartAfterDaemonControlMiss(
                { ping, runtimeStatePath },
                { readStackRuntimeStateFileImpl, isPidAliveImpl },
              );
              if (!canColdStart) {
                logger.warn(
                  `[local] watch: daemon control is unavailable (${ping?.reason ?? 'unknown'}); keeping the current daemon running.`
                );
                if (pending) continue;
                break;
              }
              await coldStart();
            }
          } catch (e) {
            const msg = e instanceof Error ? e.stack || e.message : String(e);
            logger.error('[local] watch: daemon restart failed; keeping dev runner alive (will retry on next change).');
            logger.error(msg);
            if (pending) continue;
            break;
          }
        } while (pending);
      } catch (e) {
        const msg = e instanceof Error ? e.stack || e.message : String(e);
        logger.error('[local] watch: unexpected watcher error (continuing):');
        logger.error(msg);
      } finally {
        inFlight = false;
      }
    },
  });
}
