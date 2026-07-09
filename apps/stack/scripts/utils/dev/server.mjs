import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ensureDepsInstalled, pmSpawnScript } from '../proc/pm.mjs';
import { markSpawnedProcessPlannedExit, run } from '../proc/proc.mjs';
import { applyHappyServerMigrations, ensureHappyServerManagedInfra } from '../server/infra/happy_server_infra.mjs';
import { applyServerLightEnvDefaults } from '../server/apply_server_light_env_defaults.mjs';
import { resolveServerDevScript } from '../server/flavor_scripts.mjs';
import { resolveServerReadyTimeoutMs, waitForServerReady } from '../server/server.mjs';
import { isTcpPortFree, listListenPids, pickNextFreeTcpPort, waitForTcpPortFree } from '../net/ports.mjs';
import {
  createStackDevProxyRuntimePatch,
  createStackServerRuntimeProcessPatch,
  isPidAlive,
  readStackRuntimeStateFile,
  recordStackRuntimeUpdate,
} from '../stack/runtime_state.mjs';
import { getProcessGroupId, isPidOwnedByStack, killProcessGroupOwnedByStack } from '../proc/ownership.mjs';
import { waitForPgliteDirLockRelease } from '../pglite_lock.mjs';
import { watchDebounced } from '../proc/watch.mjs';
import { pickMetroPort, resolveStablePortStart } from '../expo/metro_ports.mjs';
import { buildServerRuntimeEnv } from '../server/server_env.mjs';
import { ensureSourceServerWorkspacePackagesBuilt } from '../server/source_server_workspace_deps.mjs';
import { resolveDevReloadPollIntervalMs } from './reloadPollInterval.mjs';
import { readDevReloadWatchChangeSignature as readDevServerWatchChangeSignature } from './watchSignature.mjs';

function readPackageScripts(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    return pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch {
    return {};
  }
}

function hasPackageScript(dir, scriptName) {
  const script = readPackageScripts(dir)?.[scriptName];
  return typeof script === 'string' && script.trim().length > 0;
}

const DEFAULT_SERVER_RESTART_FAILURE_POLICY = {
  maxFailures: 3,
  windowMs: 60_000,
  backoffMs: 30_000,
  recentLineLimit: 8,
};

function normalizeServerRestartFailurePolicy(policy = {}) {
  const readPositive = (name) => {
    const value = Number(policy?.[name] ?? DEFAULT_SERVER_RESTART_FAILURE_POLICY[name]);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_SERVER_RESTART_FAILURE_POLICY[name];
  };

  return {
    maxFailures: readPositive('maxFailures'),
    windowMs: readPositive('windowMs'),
    backoffMs: readPositive('backoffMs'),
    recentLineLimit: readPositive('recentLineLimit'),
  };
}

function createRecentLineBuffer(limit) {
  const max = Math.max(0, Number(limit) || 0);
  const lines = [];
  return {
    onLine({ stream, line } = {}) {
      if (max <= 0) return;
      const normalizedLine = String(line ?? '').trimEnd();
      if (!normalizedLine) return;
      lines.push({ stream: stream === 'stdout' ? 'stdout' : 'stderr', line: normalizedLine });
      while (lines.length > max) lines.shift();
    },
    snapshot() {
      return lines.slice();
    },
  };
}

function formatRecentServerOutput(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  return [
    '[local] recent server output:',
    ...lines.map((entry) => `[local]   [${entry.stream}] ${entry.line}`),
  ].join('\n');
}

function createServerRestartFailureTracker({ policy, nowImpl }) {
  const normalizedPolicy = normalizeServerRestartFailurePolicy(policy);
  let failures = [];
  let backoffUntilMs = 0;

  const now = () => {
    const value = Number(nowImpl?.());
    return Number.isFinite(value) ? value : Date.now();
  };

  return {
    policy: normalizedPolicy,
    getBackoffRemainingMs() {
      return Math.max(0, backoffUntilMs - now());
    },
    reset() {
      failures = [];
      backoffUntilMs = 0;
    },
    record(failure) {
      if (!failure?.countsTowardBackoff) {
        return { count: failures.length, thresholdReached: false, backoffMs: 0 };
      }

      const currentTime = now();
      const windowStart = currentTime - normalizedPolicy.windowMs;
      failures = failures.filter((timestamp) => timestamp >= windowStart);
      failures.push(currentTime);

      if (failures.length < normalizedPolicy.maxFailures) {
        return { count: failures.length, thresholdReached: false, backoffMs: 0 };
      }

      backoffUntilMs = currentTime + normalizedPolicy.backoffMs;
      failures = [];
      return {
        count: normalizedPolicy.maxFailures,
        thresholdReached: true,
        backoffMs: normalizedPolicy.backoffMs,
      };
    },
  };
}

function classifyServerRestartFailure({ error, stage, child, oldServerStopped, recentLines }) {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = child?.exitCode;
  const signalCode = child?.signalCode;
  let kind = stage || 'restart';
  if (exitCode === 1) {
    kind = 'early_exit';
  } else if (stage === 'spawn') {
    kind = 'spawn';
  } else if (stage === 'readiness' || stage === 'ownership') {
    kind = 'readiness';
  }

  return {
    kind,
    message,
    oldServerStopped: Boolean(oldServerStopped),
    exitCode,
    signalCode,
    recentLines: Array.isArray(recentLines) ? recentLines : [],
    countsTowardBackoff: kind === 'spawn' || kind === 'readiness' || kind === 'early_exit',
  };
}

function annotateServerRestartError(error, failure) {
  const annotated = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(annotated, 'serverRestartFailure', {
    value: failure,
    enumerable: false,
    configurable: true,
  });
  return annotated;
}

function mergeRuntimePatches(...patches) {
  const out = {};
  for (const patch of patches) {
    if (!patch || typeof patch !== 'object') continue;
    for (const [key, value] of Object.entries(patch)) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        out[key] &&
        typeof out[key] === 'object' &&
        !Array.isArray(out[key])
      ) {
        out[key] = { ...out[key], ...value };
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

function hasChildExited(child) {
  return (
    (child?.exitCode !== null && child?.exitCode !== undefined) ||
    (child?.signalCode !== null && child?.signalCode !== undefined)
  );
}

function getDbProviderFromServerEnv(serverEnv = {}) {
  const raw = String(serverEnv.HAPPIER_DB_PROVIDER ?? serverEnv.HAPPY_DB_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'pglite' ? 'pglite' : 'sqlite';
}

export function selectDevServerRestartMode({
  dbProvider,
  migrationsChanged,
  sqliteRuntimeMigrationsNoop = false,
  overlapSafeStartup = false,
} = {}) {
  const provider = String(dbProvider ?? '').trim().toLowerCase();
  if (
    provider === 'sqlite' &&
    migrationsChanged === false &&
    sqliteRuntimeMigrationsNoop === true &&
    overlapSafeStartup === true
  ) {
    return 'blueGreen';
  }
  return 'exclusiveDb';
}

function getPgliteDbDirFromServerEnv(serverEnv = {}) {
  return String(serverEnv.HAPPIER_SERVER_LIGHT_DB_DIR ?? serverEnv.HAPPY_SERVER_LIGHT_DB_DIR ?? '').trim();
}

async function waitForProviderDbReleaseIfNeeded(
  serverEnv,
  { waitForPgliteDirLockReleaseImpl = waitForPgliteDirLockRelease } = {},
) {
  if (getDbProviderFromServerEnv(serverEnv) !== 'pglite') return;
  const dbDir = getPgliteDbDirFromServerEnv(serverEnv);
  if (!dbDir) return;
  const released = await waitForPgliteDirLockReleaseImpl(dbDir, { timeoutMs: 5_000, intervalMs: 100 });
  if (released === false) {
    throw new Error(`[local] restart refused: pglite DB lock did not release for ${dbDir}.`);
  }
}

export function createDevServerReloadDescriptors({ serverDir, existsSyncImpl = existsSync } = {}) {
  const repoRoot = resolve(serverDir, '..', '..');
  const sharedPackages = ['agents', 'cli-common', 'protocol'];
  const serverPaths = [
    join(serverDir, 'sources'),
    join(serverDir, 'scripts'),
    join(serverDir, 'prisma'),
    join(serverDir, 'package.json'),
    join(serverDir, 'tsconfig.json'),
    join(serverDir, 'tsconfig.build.json'),
  ];
  const makeDescriptor = (id, target, paths) => {
    const existingPaths = paths.filter((p) => existsSyncImpl(p));
    return {
      id,
      target,
      paths: existingPaths,
      readSignature: () => readDevServerWatchChangeSignature(existingPaths),
    };
  };

  return [
    makeDescriptor('server:app', 'server', serverPaths),
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

function resolveDevServerWatchPaths({ serverDir, existsSyncImpl = existsSync }) {
  return createDevServerReloadDescriptors({ serverDir, existsSyncImpl }).flatMap((descriptor) => descriptor.paths);
}

export async function resolveStackOwnedServerListenPid(
  { serverPort, stackName, envPath },
  { listListenPidsImpl = listListenPids, isPidOwnedByStackImpl = isPidOwnedByStack } = {},
) {
  const listenPids = await listListenPidsImpl(serverPort, { timeoutMs: 1000 }).catch(() => []);
  for (const pid of listenPids) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPidOwnedByStackImpl(pid, { stackName, envPath }).catch(() => false)) {
      return pid;
    }
  }
  return null;
}

async function assertServerPortOwnedBySpawnedProcessGroup({
  serverPort,
  spawnedPid,
  listListenPidsImpl = listListenPids,
  getProcessGroupIdImpl = getProcessGroupId,
}) {
  const rootPgid = await getProcessGroupIdImpl(spawnedPid).catch(() => null);
  if (!rootPgid) {
    throw new Error(
      `[local] server readiness ownership could not be proven on port ${serverPort}: ` +
        `process group unavailable for pid=${spawnedPid}`
    );
  }

  const listenPids = await listListenPidsImpl(serverPort, { timeoutMs: 1000 }).catch(() => null);
  if (!Array.isArray(listenPids)) {
    throw new Error(
      `[local] server readiness ownership could not be proven on port ${serverPort}: listener discovery unavailable`
    );
  }
  if (!listenPids.length) {
    throw new Error(
      `[local] server readiness ownership could not be proven on port ${serverPort}: no listener PID was discovered`
    );
  }

  for (const listenPid of listenPids) {
    // eslint-disable-next-line no-await-in-loop
    const listenPgid = await getProcessGroupIdImpl(listenPid).catch(() => null);
    if (listenPgid && listenPgid === rootPgid) {
      return Number(listenPid);
    }
  }

  throw new Error(
    `[local] server readiness was answered by another process on port ${serverPort}; ` +
      `spawned pid=${spawnedPid}, listeners=${listenPids.join(', ')}`
  );
}

async function isServerPortOwnedByProcessGroup({
  serverPort,
  rootPid,
  listListenPidsImpl = listListenPids,
  getProcessGroupIdImpl = getProcessGroupId,
}) {
  try {
    await assertServerPortOwnedBySpawnedProcessGroup({
      serverPort,
      spawnedPid: rootPid,
      listListenPidsImpl,
      getProcessGroupIdImpl,
    });
    return true;
  } catch {
    return false;
  }
}

async function cleanupProvisionalServerChild({
  child,
  children,
  stackName,
  envPath,
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
}) {
  if (!child) return;

  const pid = Number(child.pid);
  if (Number.isFinite(pid) && pid > 1) {
    await killProcessGroupOwnedByStackImpl(pid, { stackName, envPath, label: 'server', json: false }).catch(() => null);
  }
  try {
    child.kill?.('SIGTERM');
  } catch {
    // Preserve the original readiness/ownership error.
  }

  const index = children.indexOf(child);
  if (index >= 0) {
    children.splice(index, 1);
  }
}

async function killServerProcessGroupForPlannedReload({
  child,
  pid,
  stackName,
  envPath,
  killProcessGroupOwnedByStackImpl,
}) {
  const clearPlannedExit = markSpawnedProcessPlannedExit(child, 'dev-reload');
  let result = null;
  try {
    result = await killProcessGroupOwnedByStackImpl(pid, { stackName, envPath, label: 'server', json: false });
  } catch (error) {
    clearPlannedExit();
    throw error;
  }
  if (!result?.killed) {
    clearPlannedExit();
  }
  return result;
}

export async function resolveStackOwnedServerRuntimePid(
  { runtimeStatePath, runtimeServerPid, serverPort, stackName, envPath },
  {
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    isPidAliveImpl = isPidAlive,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    resolveStackOwnedServerListenPidImpl = resolveStackOwnedServerListenPid,
    listListenPidsImpl = listListenPids,
    getProcessGroupIdImpl = getProcessGroupId,
  } = {},
) {
  const state = runtimeStatePath ? await readStackRuntimeStateFileImpl(runtimeStatePath) : null;
  const candidatePid = Number(runtimeServerPid ?? state?.processes?.serverPid);
  if (Number.isFinite(candidatePid) && candidatePid > 1 && isPidAliveImpl(candidatePid)) {
    const owned = await isPidOwnedByStackImpl(candidatePid, { stackName, envPath }).catch(() => false);
    if (
      owned &&
      (await isServerPortOwnedByProcessGroup({
        serverPort,
        rootPid: candidatePid,
        listListenPidsImpl,
        getProcessGroupIdImpl,
      }))
    ) {
      return candidatePid;
    }
  }

  const listenPid = await resolveStackOwnedServerListenPidImpl({ serverPort, stackName, envPath });
  return Number.isFinite(Number(listenPid)) && Number(listenPid) > 1 ? Number(listenPid) : null;
}

export async function stopStackOwnedServerForRestart(
  { pid, serverPort, runtimeStatePath, stackName, envPath, label = 'server' },
  {
    readStackRuntimeStateFileImpl = readStackRuntimeStateFile,
    killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
    isTcpPortFreeImpl = isTcpPortFree,
    resolveStackOwnedServerListenPidImpl = resolveStackOwnedServerListenPid,
    waitForTcpPortFreeImpl = waitForTcpPortFree,
  } = {},
) {
  const state = runtimeStatePath ? await readStackRuntimeStateFileImpl(runtimeStatePath) : null;
  const recordedPid = Number(pid ?? state?.processes?.serverPid);
  let stopped = false;

  if (Number.isFinite(recordedPid) && recordedPid > 1) {
    const res = await killProcessGroupOwnedByStackImpl(recordedPid, { stackName, envPath, label, json: true });
    stopped = Boolean(res?.killed);
  }

  if (!stopped) {
    const free = await isTcpPortFreeImpl(serverPort, { host: '127.0.0.1' });
    if (!free) {
      const listenPid = await resolveStackOwnedServerListenPidImpl({ serverPort, stackName, envPath });
      if (!(Number.isFinite(Number(listenPid)) && Number(listenPid) > 1)) {
        throw new Error(
          `[local] restart refused: server port ${serverPort} is occupied and the PID is not provably stack-owned.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run, or re-run without --restart.`
        );
      }
      const res = await killProcessGroupOwnedByStackImpl(Number(listenPid), { stackName, envPath, label, json: true });
      if (!res?.killed) {
        throw new Error(
          `[local] restart refused: server port ${serverPort} is occupied by a process that could not be stopped safely.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run, or re-run without --restart.`
        );
      }
      stopped = true;
    }
  }

  const released = await waitForTcpPortFreeImpl(serverPort, { host: '127.0.0.1', timeoutMs: 5_000, intervalMs: 100 });
  if (!released) {
    throw new Error(`[local] restart refused: server port ${serverPort} did not release after stopping the previous server.`);
  }

  return { stopped, pid: recordedPid };
}

export async function preflightDevServerRestart(
  { serverDir, serverEnv = {}, consoleImpl = console },
  { runImpl = run } = {},
) {
  const enabled = String(serverEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT ?? '').trim() !== '0';
  if (!enabled) return { ran: false, reason: 'disabled' };
  if (String(serverEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE ?? '').trim() === '1') {
    return { ran: false, reason: 'already-done' };
  }
  if (!hasPackageScript(serverDir, 'build')) return { ran: false, reason: 'missing-build-script' };

  consoleImpl.log('[local] watch: server changed → preflight build...');
  await runImpl('yarn', ['-s', 'build'], {
    cwd: serverDir,
    env: {
      ...serverEnv,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: serverEnv.HAPPIER_STACK_SKIP_REFRESH_DEPS ?? '1',
    },
    stdio: 'inherit',
  });
  return { ran: true, reason: 'build-ok' };
}

export function resolveStackUiDevPortStart({ env = process.env, stackName }) {
  return resolveStablePortStart({
    env: {
      ...env,
      HAPPIER_STACK_UI_DEV_PORT_BASE: (env.HAPPIER_STACK_UI_DEV_PORT_BASE ?? '8081').toString(),
      HAPPIER_STACK_UI_DEV_PORT_RANGE: (env.HAPPIER_STACK_UI_DEV_PORT_RANGE ?? '1000').toString(),
    },
    stackName,
    baseKey: 'HAPPIER_STACK_UI_DEV_PORT_BASE',
    rangeKey: 'HAPPIER_STACK_UI_DEV_PORT_RANGE',
    defaultBase: 8081,
    defaultRange: 1000,
  });
}

export async function pickDevMetroPort({ startPort, reservedPorts = new Set(), host = '127.0.0.1' } = {}) {
  const forcedPort = (process.env.HAPPIER_STACK_UI_DEV_PORT ?? '').toString().trim();
  return await pickMetroPort({ startPort, forcedPort, reservedPorts, host });
}

export async function startDevServer({
  serverComponentName,
  serverDir,
  autostart,
  baseEnv,
  serverPort,
  serverBindPort = serverPort,
  internalServerUrl,
  publicServerUrl,
  envPath,
  stackMode,
  runtimeStatePath,
  serverAlreadyRunning,
  restart,
  children,
  spawnOptions = {},
  quiet = false,
  serverProxyRuntime = null,
}, {
  ensureDepsInstalledImpl = ensureDepsInstalled,
  ensureSourceServerWorkspacePackagesBuiltImpl = ensureSourceServerWorkspacePackagesBuilt,
  preflightDevServerRestartImpl = preflightDevServerRestart,
  stopStackOwnedServerForRestartImpl = stopStackOwnedServerForRestart,
  pmSpawnScriptImpl = pmSpawnScript,
  waitForServerReadyImpl = waitForServerReady,
  assertServerPortOwnedBySpawnedProcessGroupImpl = assertServerPortOwnedBySpawnedProcessGroup,
  recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  waitForPgliteDirLockReleaseImpl = waitForPgliteDirLockRelease,
} = {}) {
  const bindPort = Number(serverBindPort || serverPort);
  const backendInternalServerUrl = `http://127.0.0.1:${bindPort}`;
  const serverEnv = buildServerRuntimeEnv({
    baseEnv,
    serverPort: bindPort,
    publicServerUrl,
  });

  if (serverComponentName === 'happier-server-light') {
    applyServerLightEnvDefaults({ baseEnv, serverEnv, baseDir: autostart.baseDir });
  }

  if (serverComponentName === 'happier-server') {
    const managed = (baseEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1') !== '0';
    if (managed) {
      const infra = await ensureHappyServerManagedInfra({
        stackName: autostart.stackName,
        baseDir: autostart.baseDir,
        serverPort,
        publicServerUrl,
        envPath,
        env: baseEnv,
      });
      Object.assign(serverEnv, infra.env);
    }

    const autoMigrate = (baseEnv.HAPPIER_STACK_PRISMA_MIGRATE ?? '1') !== '0';
    if (autoMigrate) {
      await applyHappyServerMigrations({ serverDir, env: serverEnv });
    }
  }

  // Ensure server deps exist before any Prisma/docker work.
  await ensureDepsInstalledImpl(serverDir, serverComponentName, { quiet, env: serverEnv });

  const prismaPush = (baseEnv.HAPPIER_STACK_PRISMA_PUSH ?? '1').toString().trim() !== '0';
  const serverScript = resolveServerDevScript({ serverComponentName, serverDir, prismaPush });

  const ensureWorkspacePackagesBuiltBeforeSpawn = async () => {
    await ensureSourceServerWorkspacePackagesBuiltImpl({
      runtimeBackedStart: false,
      serverDir,
      quiet,
      env: serverEnv,
    });
  };

  // Restart behavior (stack-safe): only kill when we can prove ownership via runtime state
  // or a stale listener that is still bound to this stack.
  if (restart && stackMode && runtimeStatePath && serverAlreadyRunning) {
    await ensureWorkspacePackagesBuiltBeforeSpawn();
    await preflightDevServerRestartImpl({ serverDir, serverComponentName, serverEnv, consoleImpl: console });
    await stopStackOwnedServerForRestartImpl({
      serverPort,
      runtimeStatePath,
      stackName: autostart.stackName,
      envPath,
    });
    await waitForProviderDbReleaseIfNeeded(serverEnv, { waitForPgliteDirLockReleaseImpl });
  }

  if (serverAlreadyRunning && !restart) {
    return { serverEnv, serverScript, serverProc: null };
  }

  if (!(restart && stackMode && runtimeStatePath && serverAlreadyRunning)) {
    await ensureWorkspacePackagesBuiltBeforeSpawn();
  }

  const server = await pmSpawnScriptImpl({
    label: 'server',
    dir: serverDir,
    script: serverScript,
    env: serverEnv,
    options: spawnOptions,
    quiet,
  });
  children.push(server);
  let listenerPid = null;
  try {
    await waitForServerReadyImpl(backendInternalServerUrl, {
      timeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: serverEnv }),
      childProcess: server,
    });
    if (backendInternalServerUrl !== internalServerUrl) {
      await waitForServerReadyImpl(internalServerUrl, {
        timeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: serverEnv }),
        childProcess: server,
      });
    }
    listenerPid = await assertServerPortOwnedBySpawnedProcessGroupImpl({ serverPort: bindPort, spawnedPid: server.pid });
    if (hasChildExited(server)) {
      throw new Error(`[local] server process exited after readiness check (pid=${server.pid}, code=${server.exitCode})`);
    }
  } catch (error) {
    await cleanupProvisionalServerChild({
      child: server,
      children,
      stackName: autostart.stackName,
      envPath,
    });
    throw error;
  }
  if (stackMode && runtimeStatePath) {
    const runtimePatch = serverProxyRuntime?.enabled
      ? mergeRuntimePatches(
          createStackServerRuntimeProcessPatch({ listenerPid, wrapperPid: server.pid }),
          createStackDevProxyRuntimePatch({
            stablePort: serverPort,
            backendPort: bindPort,
            proxyPid: serverProxyRuntime.proxyPid,
            backendPid: listenerPid,
            drainingPid: null,
            mode: serverProxyRuntime.mode ?? 'proxy',
            restartMode: serverProxyRuntime.restartMode ?? 'exclusiveDb',
            fallbackReason: serverProxyRuntime.fallbackReason,
          }),
        )
      : createStackServerRuntimeProcessPatch({
          listenerPid,
          wrapperPid: server.pid,
          serverPort,
          clearProxyState: true,
        });
    await recordStackRuntimeUpdateImpl(runtimeStatePath, runtimePatch).catch(() => {});
  }
  return { serverEnv, serverScript, serverProc: server };
}

function localServerUrlForPort(port) {
  return `http://127.0.0.1:${Number(port)}`;
}

function resolveDevProxyDrainMs(serverEnv = {}) {
  const rawValue = serverEnv.HAPPIER_STACK_DEV_PROXY_DRAIN_MS;
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return 2000;
  const raw = Number(rawValue);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 2000;
}

function sleepMs(ms) {
  const delayMs = Math.max(0, Number(ms) || 0);
  return delayMs > 0 ? new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)) : Promise.resolve();
}

function removeChildFromChildren(children, child) {
  const index = Array.isArray(children) ? children.indexOf(child) : -1;
  if (index >= 0) children.splice(index, 1);
}

export function createDevServerReloadExecutor({
  enabled,
  stackMode,
  serverComponentName,
  serverDir,
  serverPort,
  serverBindPort = serverPort,
  internalServerUrl,
  serverScript,
  serverEnv,
  runtimeStatePath,
  stackName,
  envPath,
  children,
  serverProcRef,
  isShuttingDown,
  proxyController = null,
  serverRestartModeContext = {},
}, {
  ensureSourceServerWorkspacePackagesBuiltImpl = ensureSourceServerWorkspacePackagesBuilt,
  preflightDevServerRestartImpl = preflightDevServerRestart,
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  isTcpPortFreeImpl = isTcpPortFree,
  waitForTcpPortFreeImpl = waitForTcpPortFree,
  waitForPgliteDirLockReleaseImpl = waitForPgliteDirLockRelease,
  pickNextFreeTcpPortImpl = pickNextFreeTcpPort,
  pmSpawnScriptImpl = pmSpawnScript,
  waitForServerReadyImpl = waitForServerReady,
  listListenPidsImpl = listListenPids,
  getProcessGroupIdImpl = getProcessGroupId,
  isPidAliveImpl = isPidAlive,
  recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  nowImpl = Date.now,
  restartFailurePolicy,
  logger = console,
  sleepImpl = sleepMs,
} = {}) {
  let activeBackendPort = Number(serverBindPort || serverPort);
  const restartFailureTracker = createServerRestartFailureTracker({ policy: restartFailurePolicy, nowImpl });

  const cleanupSpawnedChild = async (child) => {
    await cleanupProvisionalServerChild({
      child,
      children,
      stackName,
      envPath,
      killProcessGroupOwnedByStackImpl,
    });
  };

  const spawnServerBackend = async ({ port, recentLineBuffer }) => {
    const nextEnv = { ...serverEnv, PORT: String(port) };
    let next = null;
    try {
      next = await pmSpawnScriptImpl({
        label: 'server',
        dir: serverDir,
        script: serverScript,
        env: nextEnv,
        options: { onLine: recentLineBuffer.onLine },
      });
      children.push(next);
      const readyUrl = localServerUrlForPort(port);
      await waitForServerReadyImpl(readyUrl, {
        timeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: nextEnv }),
        childProcess: next,
      });
      const listenerPid = await assertServerPortOwnedBySpawnedProcessGroup({
        serverPort: port,
        spawnedPid: next.pid,
        listListenPidsImpl,
        getProcessGroupIdImpl,
      });
      if (hasChildExited(next)) {
        throw new Error(
          `[local] server process exited after readiness check ` +
            `(pid=${next.pid}, code=${next.exitCode ?? 'null'}, signal=${next.signalCode ?? 'null'})`
        );
      }
      return { child: next, listenerPid };
    } catch (error) {
      await cleanupSpawnedChild(next);
      throw error;
    }
  };

  const recordProxyBackend = async ({ backendPort, listenerPid, wrapperPid, restartMode, drainingPid = null }) => {
    if (!(stackMode && runtimeStatePath)) return;
    await recordStackRuntimeUpdateImpl(
      runtimeStatePath,
      mergeRuntimePatches(
        createStackServerRuntimeProcessPatch({ listenerPid, wrapperPid }),
        createStackDevProxyRuntimePatch({
          stablePort: serverPort,
          backendPort,
          proxyPid: proxyController?.pid,
          backendPid: listenerPid,
          drainingPid,
          mode: 'proxy',
          restartMode,
        }),
      ),
    ).catch(() => {});
  };

  const backendDrainTarget = (port) => ({
    targetHost: '127.0.0.1',
    targetPort: Number(port),
  });

  const normalizeDrainTarget = (target) => {
    if (!target) return null;
    const targetPort = Number(target.targetPort ?? target.port);
    if (!Number.isInteger(targetPort) || targetPort <= 0) return null;
    return {
      targetHost: String(target.targetHost ?? target.host ?? '127.0.0.1'),
      targetPort,
    };
  };

  const drainProxyTargets = async (targets, { graceMs = 0 } = {}) => {
    const normalizedTargets = targets
      .map((target) => normalizeDrainTarget(target))
      .filter(Boolean);

    if (typeof proxyController?.drainConnections === 'function') {
      for (const target of normalizedTargets) {
        await proxyController.drainConnections({ ...target, graceMs });
      }
      return;
    }

    if (normalizedTargets.length === 0 && typeof proxyController?.drainOldConnections === 'function') {
      await proxyController.drainOldConnections({ graceMs });
    }
  };

  const flipProxyUpstreamAndDrainTargets = async ({
    targetPort,
    drainTargets,
    graceMs = resolveDevProxyDrainMs(serverEnv),
  }) => {
    proxyController.flipUpstream?.({ targetPort });
    await drainProxyTargets(drainTargets, { graceMs });
  };

  const restartWithExclusiveDbProxy = async () => {
    const currentServerProc = serverProcRef?.current;
    const pid = Number(currentServerProc?.pid);
    if (!Number.isFinite(pid) || pid <= 1) return false;

    const restartMode = 'exclusiveDb';
    const recentLineBuffer = createRecentLineBuffer(restartFailureTracker.policy.recentLineLimit);
    const oldBackendPort = activeBackendPort;
    const oldBackendTarget = backendDrainTarget(oldBackendPort);
    let oldServerStopped = false;
    let replacement = null;
    let maintenanceTarget = null;
    let attemptedReplacementTarget = null;

    const ownsCurrentListener = await isServerPortOwnedByProcessGroup({
      serverPort: oldBackendPort,
      rootPid: pid,
      listListenPidsImpl,
      getProcessGroupIdImpl,
    });
    if (!ownsCurrentListener) {
      const free = await isTcpPortFreeImpl(oldBackendPort, { host: '127.0.0.1' });
      const currentPidStillAlive = !hasChildExited(currentServerProc) && isPidAliveImpl(pid);
      if (currentPidStillAlive || !free) {
        throw new Error(
          `[local] watch restart refused: server backend port ${oldBackendPort} is not provably stack-owned.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
    }

    maintenanceTarget = normalizeDrainTarget(await proxyController.enterMaintenance?.({
      retryAfterMs: Math.max(1, resolveDevProxyDrainMs(serverEnv)),
      message: 'Server reload in progress',
    }));
    if (ownsCurrentListener) {
      const killResult = await killServerProcessGroupForPlannedReload({
        child: currentServerProc,
        pid,
        stackName,
        envPath,
        killProcessGroupOwnedByStackImpl,
      });
      if (!killResult?.killed) {
        await flipProxyUpstreamAndDrainTargets({
          targetPort: oldBackendPort,
          drainTargets: [maintenanceTarget],
        });
        throw new Error(
          `[local] watch restart refused: server pid ${pid} owns backend port ${oldBackendPort} but could not be stopped safely.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      oldServerStopped = true;
      removeChildFromChildren(children, currentServerProc);
    }

    try {
      const released = await waitForTcpPortFreeImpl(oldBackendPort, { host: '127.0.0.1', timeoutMs: 5_000, intervalMs: 100 });
      if (!released) {
        throw new Error(`[local] watch restart refused: server backend port ${oldBackendPort} did not release after stopping pid=${pid}.`);
      }
      await waitForProviderDbReleaseIfNeeded(serverEnv, { waitForPgliteDirLockReleaseImpl });
      const nextBackendPort = await pickNextFreeTcpPortImpl(oldBackendPort + 1, {
        host: '127.0.0.1',
        reservedPorts: new Set([Number(serverPort), oldBackendPort]),
      });
      attemptedReplacementTarget = backendDrainTarget(nextBackendPort);
      replacement = await spawnServerBackend({ port: nextBackendPort, recentLineBuffer });
      serverProcRef.current = replacement.child;
      activeBackendPort = nextBackendPort;
      await flipProxyUpstreamAndDrainTargets({
        targetPort: nextBackendPort,
        drainTargets: [maintenanceTarget, oldBackendTarget],
      });
      await recordProxyBackend({
        backendPort: nextBackendPort,
        listenerPid: replacement.listenerPid,
        wrapperPid: replacement.child.pid,
        restartMode,
      });
      logger.log(`[local] watch: server restarted behind proxy (pid=${replacement.child.pid}, backendPort=${nextBackendPort})`);
      return true;
    } catch (error) {
      if (oldServerStopped) {
        await flipProxyUpstreamAndDrainTargets({
          targetPort: oldBackendPort,
          drainTargets: [maintenanceTarget, attemptedReplacementTarget],
        }).catch((rollbackError) => {
          logger.error(
            `[local] watch: proxy rollback drain failed after restart error: ` +
              `${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        });
      }
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({
          error,
          stage: oldServerStopped ? 'readiness' : 'restart',
          child: replacement?.child ?? null,
          oldServerStopped,
          recentLines: recentLineBuffer.snapshot(),
        }),
      );
    }
  };

  const restartDirect = async () => {
    const currentServerProc = serverProcRef?.current;
    const pid = Number(currentServerProc?.pid);
    if (!Number.isFinite(pid) || pid <= 1) return false;

    let oldServerStopped = false;
    const recentLineBuffer = createRecentLineBuffer(restartFailureTracker.policy.recentLineLimit);
    const ownsCurrentListener = await isServerPortOwnedByProcessGroup({
      serverPort,
      rootPid: pid,
      listListenPidsImpl,
      getProcessGroupIdImpl,
    });
    if (ownsCurrentListener) {
      const killResult = await killServerProcessGroupForPlannedReload({
        child: currentServerProc,
        pid,
        stackName,
        envPath,
        killProcessGroupOwnedByStackImpl,
      });
      if (!killResult?.killed) {
        throw new Error(
          `[local] watch restart refused: server pid ${pid} owns port ${serverPort} but could not be stopped safely.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
      oldServerStopped = true;
      removeChildFromChildren(children, currentServerProc);
    } else {
      const free = await isTcpPortFreeImpl(serverPort, { host: '127.0.0.1' });
      const currentPidStillAlive = !hasChildExited(currentServerProc) && isPidAliveImpl(pid);
      if (currentPidStillAlive || !free) {
        throw new Error(
          `[local] watch restart refused: server port ${serverPort} is occupied and the running PID does not own it.\n` +
            `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
        );
      }
    }
    const released = await waitForTcpPortFreeImpl(serverPort, { host: '127.0.0.1', timeoutMs: 5_000, intervalMs: 100 });
    if (!released) {
      const error = new Error(`[local] watch restart refused: server port ${serverPort} did not release after stopping pid=${pid}.`);
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({ error, stage: 'post-stop', child: null, oldServerStopped, recentLines: recentLineBuffer.snapshot() }),
      );
    }
    await waitForProviderDbReleaseIfNeeded(serverEnv, { waitForPgliteDirLockReleaseImpl });
    let next = null;
    try {
      next = await spawnServerBackend({ port: serverPort, recentLineBuffer });
      serverProcRef.current = next.child;
      if (stackMode && runtimeStatePath) {
        await recordStackRuntimeUpdateImpl(
          runtimeStatePath,
          createStackServerRuntimeProcessPatch({
            listenerPid: next.listenerPid,
            wrapperPid: next.child.pid,
            serverPort,
            clearProxyState: true,
          }),
        ).catch(() => {});
      }
      logger.log(`[local] watch: server restarted (pid=${next.child.pid}, port=${serverPort})`);
      return true;
    } catch (error) {
      throw annotateServerRestartError(
        error,
        classifyServerRestartFailure({ error, stage: 'readiness', child: next?.child ?? null, oldServerStopped, recentLines: recentLineBuffer.snapshot() }),
      );
    }
  };

  const restartOnce = async () => {
    if (proxyController) {
      const mode = selectDevServerRestartMode({
        dbProvider: getDbProviderFromServerEnv(serverEnv),
        ...serverRestartModeContext,
      });
      if (mode === 'blueGreen') {
        const currentServerProc = serverProcRef?.current;
        const pid = Number(currentServerProc?.pid);
        if (!Number.isFinite(pid) || pid <= 1) return false;

        const recentLineBuffer = createRecentLineBuffer(restartFailureTracker.policy.recentLineLimit);
        const oldBackendPort = activeBackendPort;
        const oldBackendTarget = backendDrainTarget(oldBackendPort);
        let oldListenerPid = await assertServerPortOwnedBySpawnedProcessGroup({
          serverPort: oldBackendPort,
          spawnedPid: pid,
          listListenPidsImpl,
          getProcessGroupIdImpl,
        }).catch(() => null);

        if (!(Number.isFinite(Number(oldListenerPid)) && Number(oldListenerPid) > 1)) {
          const free = await isTcpPortFreeImpl(oldBackendPort, { host: '127.0.0.1' });
          const currentPidStillAlive = !hasChildExited(currentServerProc) && isPidAliveImpl(pid);
          if (currentPidStillAlive || !free) {
            throw new Error(
              `[local] watch restart refused: server backend port ${oldBackendPort} is not provably stack-owned.\n` +
                `[local] Fix: run 'hstack stack stop ${stackName}' then re-run.`
            );
          }
          oldListenerPid = null;
        }

        const nextBackendPort = await pickNextFreeTcpPortImpl(oldBackendPort + 1, {
          host: '127.0.0.1',
          reservedPorts: new Set([Number(serverPort), oldBackendPort]),
        });
        const replacement = await spawnServerBackend({ port: nextBackendPort, recentLineBuffer });
        serverProcRef.current = replacement.child;
        activeBackendPort = nextBackendPort;
        proxyController.flipUpstream?.({ targetPort: nextBackendPort });
        await recordProxyBackend({
          backendPort: nextBackendPort,
          listenerPid: replacement.listenerPid,
          wrapperPid: replacement.child.pid,
          restartMode: 'blueGreen',
          drainingPid: oldListenerPid,
        });
        await drainProxyTargets([oldBackendTarget], { graceMs: resolveDevProxyDrainMs(serverEnv) });

        if (oldListenerPid) {
          const killResult = await killServerProcessGroupForPlannedReload({
            child: currentServerProc,
            pid,
            stackName,
            envPath,
            killProcessGroupOwnedByStackImpl,
          })
            .catch(() => ({ killed: false }));
          if (killResult?.killed) {
            removeChildFromChildren(children, currentServerProc);
            await recordProxyBackend({
              backendPort: nextBackendPort,
              listenerPid: replacement.listenerPid,
              wrapperPid: replacement.child.pid,
              restartMode: 'blueGreen',
              drainingPid: null,
            });
          } else {
            logger.error?.(
              `[local] watch: old server backend pid ${pid} did not stop after blue-green flip; ` +
                'leaving serverDrainingPid in runtime state for stack stop cleanup.'
            );
          }
        } else {
          removeChildFromChildren(children, currentServerProc);
          await recordProxyBackend({
            backendPort: nextBackendPort,
            listenerPid: replacement.listenerPid,
            wrapperPid: replacement.child.pid,
            restartMode: 'blueGreen',
            drainingPid: null,
          });
        }

        return true;
      }
      return await restartWithExclusiveDbProxy();
    }
    return await restartDirect();
  };

  return {
    target: 'server',
    async build() {
      if (!enabled || isShuttingDown?.()) return { skipped: true };
      await ensureSourceServerWorkspacePackagesBuiltImpl({
        runtimeBackedStart: false,
        serverDir,
        env: serverEnv,
      });
      await preflightDevServerRestartImpl({ serverDir, serverComponentName, serverEnv, consoleImpl: logger, logger });
      return { ok: true };
    },
    async restart() {
      if (!enabled || isShuttingDown?.()) return { skipped: true };
      const backoffRemainingMs = restartFailureTracker.getBackoffRemainingMs();
      if (backoffRemainingMs > 0) {
        logger.error(
          `[local] watch: server restart suppressed; backing off for ${backoffRemainingMs}ms after repeated startup failures.`
        );
        return { skipped: true, reason: 'backoff' };
      }
      try {
        const restarted = await restartOnce();
        if (restarted) restartFailureTracker.reset();
        return { restarted };
      } catch (error) {
        const failure = error?.serverRestartFailure;
        if (failure?.oldServerStopped) {
          logger.error(
            `[local] watch: server restart failed after stopping the previous process; ` +
              `no server is running on port ${serverPort} (will retry on next change).`
          );
        } else {
          logger.error('[local] watch: server restart failed; keeping existing process as-is (will retry on next change).');
        }
        const recentOutput = formatRecentServerOutput(failure?.recentLines);
        if (recentOutput) logger.error(recentOutput);
        const backoff = restartFailureTracker.record(failure);
        if (backoff.thresholdReached) {
          logger.error(
            `[local] watch: server failed to start ${backoff.count} times within ` +
              `${restartFailureTracker.policy.windowMs}ms; backing off for ${backoff.backoffMs}ms.`
          );
        }
        throw error;
      }
    },
  };
}

export function watchDevServerAndRestart({
  enabled,
  stackMode,
  serverComponentName,
  serverDir,
  serverPort,
  internalServerUrl,
  serverScript,
  serverEnv,
  runtimeStatePath,
  stackName,
  envPath,
  children,
  serverProcRef,
  isShuttingDown,
}, {
  watchDebouncedImpl = watchDebounced,
  pmSpawnScriptImpl = pmSpawnScript,
  killProcessGroupOwnedByStackImpl = killProcessGroupOwnedByStack,
  isTcpPortFreeImpl = isTcpPortFree,
  waitForTcpPortFreeImpl = waitForTcpPortFree,
  stopStackOwnedServerForRestartImpl = stopStackOwnedServerForRestart,
  recordStackRuntimeUpdateImpl = recordStackRuntimeUpdate,
  waitForServerReadyImpl = waitForServerReady,
  listListenPidsImpl = listListenPids,
  getProcessGroupIdImpl = getProcessGroupId,
  preflightDevServerRestartImpl = preflightDevServerRestart,
  ensureSourceServerWorkspacePackagesBuiltImpl = ensureSourceServerWorkspacePackagesBuilt,
  waitForPgliteDirLockReleaseImpl = waitForPgliteDirLockRelease,
  readWatchChangeSignatureImpl = readDevServerWatchChangeSignature,
  existsSyncImpl = existsSync,
  nowImpl = Date.now,
  restartFailurePolicy,
  consoleImpl = console,
} = {}) {
  if (!enabled) return null;

  // Both server flavors are spawned through plain tsx dev scripts; stack watch owns source-change restarts.
  if (serverComponentName !== 'happier-server' && serverComponentName !== 'happier-server-light') return null;

  let inFlight = false;
  let pending = false;
  const watchPaths = resolveDevServerWatchPaths({ serverDir, existsSyncImpl });
  let lastWatchSignature = readWatchChangeSignatureImpl(watchPaths);
  const restartFailureTracker = createServerRestartFailureTracker({
    policy: restartFailurePolicy,
    nowImpl,
  });

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
    paths: (watchPaths.length ? watchPaths : [serverDir]).map((p) => resolve(p)),
    debounceMs: 600,
    readSignature: () => readWatchChangeSignatureImpl(watchPaths),
    pollIntervalMs: resolveDevReloadPollIntervalMs(serverEnv),
    onChange: async () => {
      if (isShuttingDown?.()) return;
      if (!hasRealWatchedChange()) return;
      const backoffRemainingMs = restartFailureTracker.getBackoffRemainingMs();
      if (backoffRemainingMs > 0) {
        consoleImpl.error(
          `[local] watch: server restart suppressed; backing off for ${backoffRemainingMs}ms after repeated startup failures.`
        );
        return;
      }
      if (inFlight) {
        pending = true;
        return;
      }

      inFlight = true;
      try {
        do {
          pending = false;
          if (isShuttingDown?.()) return;
          const pid = Number(serverProcRef?.current?.pid);
          const hasCurrentPid = Number.isFinite(pid) && pid > 1;

          let previousServerStopped = false;
          const recentLineBuffer = createRecentLineBuffer(restartFailureTracker.policy.recentLineLimit);
          try {
            await ensureSourceServerWorkspacePackagesBuiltImpl({
              runtimeBackedStart: false,
              serverDir,
              env: serverEnv,
            });
            await preflightDevServerRestartImpl({ serverDir, serverComponentName, serverEnv, consoleImpl });

            consoleImpl.log('[local] watch: server preflight passed → restarting...');
            const clearPlannedExit = hasCurrentPid
              ? markSpawnedProcessPlannedExit(serverProcRef.current, 'dev-reload')
              : () => {};
            let stopResult = null;
            try {
              stopResult = await stopStackOwnedServerForRestartImpl(
                { pid: hasCurrentPid ? pid : undefined, serverPort, stackName, envPath, label: 'server' },
                {
                  killProcessGroupOwnedByStackImpl,
                  isTcpPortFreeImpl,
                  waitForTcpPortFreeImpl,
                },
              );
            } catch (error) {
              clearPlannedExit();
              throw error;
            }
            if (!stopResult?.stopped) {
              clearPlannedExit();
            }
            previousServerStopped = Boolean(stopResult?.stopped || hasCurrentPid);
            serverProcRef.current = null;
            await waitForProviderDbReleaseIfNeeded(serverEnv, { waitForPgliteDirLockReleaseImpl });

            let next = null;
            let listenerPid = null;
            let restartStage = 'spawn';
            try {
              next = await pmSpawnScriptImpl({
                label: 'server',
                dir: serverDir,
                script: serverScript,
                env: serverEnv,
                options: { onLine: recentLineBuffer.onLine },
              });
              children.push(next);
              restartStage = 'readiness';
              await waitForServerReadyImpl(internalServerUrl, {
                timeoutMs: resolveServerReadyTimeoutMs({ serverComponentName, env: serverEnv }),
                childProcess: next,
              });
              restartStage = 'ownership';
              listenerPid = await assertServerPortOwnedBySpawnedProcessGroup({
                serverPort,
                spawnedPid: next.pid,
                listListenPidsImpl,
                getProcessGroupIdImpl,
              });
              if (hasChildExited(next)) {
                throw new Error(
                  `[local] server process exited after readiness check ` +
                    `(pid=${next.pid}, code=${next.exitCode ?? 'null'}, signal=${next.signalCode ?? 'null'})`
                );
              }
            } catch (error) {
              await cleanupProvisionalServerChild({
                child: next,
                children,
                stackName,
                envPath,
                killProcessGroupOwnedByStackImpl,
              });
              throw annotateServerRestartError(
                error,
                classifyServerRestartFailure({
                  error,
                  stage: restartStage,
                  child: next,
                  oldServerStopped: previousServerStopped,
                  recentLines: recentLineBuffer.snapshot(),
                }),
              );
            }
            serverProcRef.current = next;
            if (stackMode && runtimeStatePath) {
              await recordStackRuntimeUpdateImpl(
                runtimeStatePath,
                createStackServerRuntimeProcessPatch({ listenerPid, wrapperPid: next.pid }),
              ).catch(() => {});
            }
            consoleImpl.log(`[local] watch: server restarted (pid=${next.pid}, port=${serverPort})`);
            restartFailureTracker.reset();
          } catch (e) {
            const msg = e instanceof Error ? e.stack || e.message : String(e);
            const failure = e?.serverRestartFailure;
            if (previousServerStopped) {
              consoleImpl.error(
                `[local] watch: server restart failed after stopping the previous process; ` +
                  `no server is running on port ${serverPort} (will retry on next change).`
              );
            } else {
              consoleImpl.error('[local] watch: server restart failed; keeping existing process as-is (will retry on next change).');
            }
            consoleImpl.error(msg);
            const recentOutput = formatRecentServerOutput(failure?.recentLines);
            if (recentOutput) consoleImpl.error(recentOutput);
            const backoff = restartFailureTracker.record(failure);
            if (backoff.thresholdReached) {
              consoleImpl.error(
                `[local] watch: server failed to start ${backoff.count} times within ` +
                  `${restartFailureTracker.policy.windowMs}ms; backing off for ${backoff.backoffMs}ms.`
              );
              pending = false;
            }
          }
        } while (pending);
      } finally {
        inFlight = false;
      }
    },
  });
}
