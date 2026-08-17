import { runManagedChildCommand } from '../../../scripts/testing/process/managedChildLifecycle.mjs';
import { sweepStaleProcessOwnershipLeases } from './sweepProcessOwnershipLeases.mjs';

export { installParentDeathCleanupWatchdog, resolveSignalExitCode } from '../../../scripts/testing/process/managedChildLifecycle.mjs';

export function parseHeartbeatArgs(argv) {
  const args = argv.slice(2);
  let config = null;
  const passThrough = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--config') {
      config = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--config=')) {
      config = arg.slice('--config='.length) || null;
      continue;
    }
    passThrough.push(arg);
  }

  return { config, passThrough };
}

export function createPlaywrightSpawnOptions(env) {
  const nextEnv = {
    ...env,
    PLAYWRIGHT_HTML_OPEN: 'never',
  };
  return {
    stdio: 'inherit',
    env: nextEnv,
    detached: process.platform !== 'win32',
  };
}

function resolveWrapperTimeoutMs(env, fallbackMs = null) {
  const rawTimeoutMs = String(env?.HAPPIER_TEST_WRAPPER_TIMEOUT_MS ?? '').trim();
  if (rawTimeoutMs.length > 0) {
    const parsed = Number.parseInt(rawTimeoutMs, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return Number.isFinite(fallbackMs) && fallbackMs > 0 ? fallbackMs : null;
}

function elapsedSeconds(startedAtMs) {
  return Math.floor((Date.now() - startedAtMs) / 1000);
}

export async function runHeartbeatWrappedCommand(params) {
  const startedAt = Date.now();
  // Reap stale detached lease-owned helpers before spawning a new child run.
  // This prevents a previous crashed wrapper from destabilizing the next run.
  await sweepStaleProcessOwnershipLeases().catch(() => {});
  // eslint-disable-next-line no-console
  console.log(`[tests] starting: ${params.command} ${params.args.join(' ')}`);

  const heartbeatMs = Number.parseInt(process.env.HAPPIER_TEST_HEARTBEAT_MS ?? '30000', 10);
  const safeHeartbeatMs = Number.isFinite(heartbeatMs) && heartbeatMs >= 1000 ? heartbeatMs : 30000;
  const wrapperTimeoutMs = resolveWrapperTimeoutMs(process.env, params.defaultTimeoutMs ?? null);

  const heartbeat = setInterval(() => {
    // eslint-disable-next-line no-console
    console.log(`[tests] still running (${elapsedSeconds(startedAt)}s elapsed): ${params.config}`);
  }, safeHeartbeatMs);

  let finished = false;
  function clearHeartbeat() {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
  }

  const result = await runManagedChildCommand({
    command: params.command,
    args: params.args,
    spawnOptions: params.spawnOptions,
    cleanupPollMs: 25,
    signalCleanupGraceMs: 0,
    exitCleanupGraceMs: 1_000,
    maxRuntimeMs: wrapperTimeoutMs,
    parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
    onProcessSignal: () => {
      clearHeartbeat();
    },
    onMaxRuntime: (maxRuntimeMs) => {
      clearHeartbeat();
      // eslint-disable-next-line no-console
      console.error(`[tests] timed out after ${Math.ceil(maxRuntimeMs / 1000)}s: ${params.config}`);
    },
    onParentDeath: async () => {
      clearHeartbeat();
      process.exit(1);
    },
  });

  clearHeartbeat();

  // Ensure detached lease-owned processes (Metro, server-light, etc.) do not survive a failed run.
  // These are tracked under `.project/tmp/*-processes` and should be safe to reap once the
  // Playwright child has exited (owners are dead/stale by definition at this point).
  await sweepStaleProcessOwnershipLeases().catch(() => {});

  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.error(`[tests] failed to start ${params.toolName}: ${result.error.message}`);
    process.exit(1);
  }

  const exitCode = result.timedOut === true ? 124 : params.resolveExitCode(result);
  // eslint-disable-next-line no-console
  console.log(`[tests] completed in ${elapsedSeconds(startedAt)}s with code ${exitCode}`);
  process.exit(exitCode);
}
