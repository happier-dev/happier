import { runManagedChildCommand } from './managedChildLifecycle.mjs';

export { installParentDeathCleanupWatchdog, resolveSignalExitCode } from './managedChildLifecycle.mjs';

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

function resolveUiWebExportNamespace(env) {
  const explicitNamespace = String(env?.HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE ?? '').trim();
  if (explicitNamespace) return explicitNamespace;
  return `playwright-ui-${process.pid}-${Date.now()}`;
}

export function createPlaywrightSpawnOptions(env) {
  const nextEnv = {
    ...env,
    HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: resolveUiWebExportNamespace(env),
  };
  return {
    stdio: 'inherit',
    env: nextEnv,
    detached: process.platform !== 'win32',
  };
}

function elapsedSeconds(startedAtMs) {
  return Math.floor((Date.now() - startedAtMs) / 1000);
}

export async function runHeartbeatWrappedCommand(params) {
  const startedAt = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[tests] starting: ${params.command} ${params.args.join(' ')}`);

  const heartbeatMs = Number.parseInt(process.env.HAPPIER_TEST_HEARTBEAT_MS ?? '30000', 10);
  const safeHeartbeatMs = Number.isFinite(heartbeatMs) && heartbeatMs >= 1000 ? heartbeatMs : 30000;

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
    parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
    onProcessSignal: () => {
      clearHeartbeat();
    },
    onParentDeath: async () => {
      clearHeartbeat();
      process.exit(1);
    },
  });

  clearHeartbeat();

  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.error(`[tests] failed to start ${params.toolName}: ${result.error.message}`);
    process.exit(1);
  }

  const exitCode = params.resolveExitCode(result);
  // eslint-disable-next-line no-console
  console.log(`[tests] completed in ${elapsedSeconds(startedAt)}s with code ${exitCode}`);
  process.exit(exitCode);
}
