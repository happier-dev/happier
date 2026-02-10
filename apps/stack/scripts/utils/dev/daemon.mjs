import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { ensureCliBuilt, ensureDepsInstalled } from '../proc/pm.mjs';
import { watchDebounced } from '../proc/watch.mjs';
import { getAccountCountForServerComponent, prepareDaemonAuthSeedIfNeeded } from '../stack/startup.mjs';
import { startLocalDaemonWithAuth } from '../../daemon.mjs';

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
    isShuttingDown,
    forceRestart: Boolean(restart),
    env,
    stackName,
    cliIdentity,
  });
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
  isShuttingDown,
  env = process.env,
  stackName = null,
  cliIdentity = 'default',
}, {
  watchDebouncedImpl = watchDebounced,
  ensureCliBuiltImpl = ensureCliBuilt,
  startLocalDaemonWithAuthImpl = startLocalDaemonWithAuth,
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
  const watchPaths = [
    join(cliDir, 'src'),
    join(cliDir, 'bin'),
    join(cliDir, 'codex'),
    join(cliDir, 'package.json'),
    join(cliDir, 'tsconfig.json'),
    join(cliDir, 'tsconfig.build.json'),
    join(cliDir, 'pkgroll.config.mjs'),
    join(cliDir, 'yarn.lock'),
  ].filter((p) => existsSyncImpl(p));

  return watchDebouncedImpl({
    paths: (watchPaths.length ? watchPaths : [cliDir]).map((p) => resolve(p)),
    debounceMs: 500,
    onChange: async () => {
      if (isShuttingDown?.()) return;
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

          try {
            await startLocalDaemonWithAuthImpl({
              cliBin,
              cliHomeDir,
              internalServerUrl,
              publicServerUrl,
              isShuttingDown,
              forceRestart: true,
              env,
              stackName,
              cliIdentity,
            });
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
