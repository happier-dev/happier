import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { ensureCliBuilt, ensureDepsInstalled } from '../proc/pm.mjs';
import { watchDebounced } from '../proc/watch.mjs';
import { getAccountCountForServerComponent, prepareDaemonAuthSeedIfNeeded } from '../stack/startup.mjs';
import { startLocalDaemonWithAuth } from '../../daemon.mjs';

export async function ensureDevCliReady({ cliDir, buildCli }) {
  await ensureDepsInstalled(cliDir, 'happier-cli');
  const res = await ensureCliBuilt(cliDir, { buildCli });

  // Fail closed: dev mode must never start the daemon without a usable happier-cli build output.
  // Even if the user disabled CLI builds globally (or build mode is "never"), missing dist will
  // cause an immediate MODULE_NOT_FOUND crash when spawning the daemon.
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  if (!existsSync(distEntrypoint)) {
    // Last-chance recovery: force a build once.
    await ensureCliBuilt(cliDir, { buildCli: true });
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
}) {
  if (!startDaemon) return;
  await startLocalDaemonWithAuth({
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown,
    forceRestart: Boolean(restart),
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
}) {
  if (!enabled || !startDaemon) return null;

  let inFlight = false;

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
  ].filter((p) => existsSync(p));

  return watchDebounced({
    paths: (watchPaths.length ? watchPaths : [cliDir]).map((p) => resolve(p)),
    debounceMs: 500,
    onChange: async () => {
      if (isShuttingDown?.()) return;
      if (inFlight) return;
      inFlight = true;
      try {
        // eslint-disable-next-line no-console
        console.log('[local] watch: happier-cli changed → rebuilding + restarting daemon...');
        try {
          await ensureCliBuilt(cliDir, { buildCli });
        } catch (e) {
          // IMPORTANT:
          // - A rebuild can legitimately fail while an agent is mid-edit (e.g. TS errors).
          // - In that case we must NOT restart the daemon (we'd just restart into a broken build),
          //   and we must NOT crash the parent dev process. Keep watching for the next change.
          const msg = e instanceof Error ? e.stack || e.message : String(e);
          // eslint-disable-next-line no-console
          console.error('[local] watch: happier-cli rebuild failed; keeping daemon running (will retry on next change).');
          // eslint-disable-next-line no-console
          console.error(msg);
          return;
        }
        const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
        if (!existsSync(distEntrypoint)) {
          console.warn(
            `[local] watch: happier-cli build did not produce ${distEntrypoint}; refusing to restart daemon to avoid downtime.`
          );
          return;
        }
        await startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          isShuttingDown,
          forceRestart: true,
        });
      } finally {
        inFlight = false;
      }
    },
  });
}
