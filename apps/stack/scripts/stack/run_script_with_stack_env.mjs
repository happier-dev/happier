import { spawn } from 'node:child_process';
import { open, readFile as readFileText, readdir, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { buildConfigureServerLinks } from '@happier-dev/cli-common/links';

import { cleanupStaleDaemonState, stopLocalDaemon } from '../daemon.mjs';
import { findExistingStackCredentialPath, resolveStackDaemonStatePaths } from '../utils/auth/credentials_paths.mjs';
import { ensureDir } from '../utils/fs/ops.mjs';
import { readLastLines } from '../utils/fs/tail.mjs';
import { isTcpPortFree, listListenPids, pickNextFreeTcpPort } from '../utils/net/ports.mjs';
import { getComponentDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { resolveLocalhostHost } from '../utils/paths/localhost_host.mjs';
import { killProcessGroupOwnedByStack } from '../utils/proc/ownership.mjs';
import { run } from '../utils/proc/proc.mjs';
import { coercePort } from '../utils/server/port.mjs';
import { waitForHttpOk } from '../utils/server/server.mjs';
import { getCliHomeDirFromEnvOrDefault } from '../utils/stack/dirs.mjs';
import { findRunningExpoStateInRoot, looksLikeExpoMetro } from '../utils/expo/expo.mjs';
import { resolveExpoTailscaleEnabled } from '../utils/dev/expo_dev_tailscale.mjs';
import {
  deleteStackRuntimeStateFile,
  getStackRuntimeProcessEntries,
  getStackRuntimeStatePath,
  isPidAlive,
  recordStackRuntimeStart,
  readStackRuntimeStateFile,
} from '../utils/stack/runtime_state.mjs';
import { listAllStackNames } from '../utils/stack/stacks.mjs';
import { stopStackWithEnv } from '../utils/stack/stop.mjs';
import { openUrlInBrowser } from '../utils/ui/browser.mjs';

import { collectReservedStackPorts, getDefaultPortStart } from './port_reservation.mjs';
import { withStackEnv } from './stack_environment.mjs';
import { resolveStackRuntimeLaunchContext } from '../runtime/launch/resolveStackRuntimeLaunchContext.mjs';

export function hasRecordedRuntimePortsForRestart(runtimeState = null) {
  const ports = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : null;
  return Number(ports?.server) > 0;
}

export function shouldReuseRuntimePortsOnRestart({ wantsRestart = false, runtimeState = null, wasRunning = false } = {}) {
  return Boolean(wantsRestart && (wasRunning || hasRecordedRuntimePortsForRestart(runtimeState)));
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
  const existingExpoPort = Number(runtimeState?.expo?.port ?? runtimeState?.expo?.webPort ?? runtimeState?.expo?.mobilePort);

  const wantsUi = scriptPath === 'dev.mjs' && !args.includes('--no-ui');
  const wantsMobile = scriptPath === 'dev.mjs' && isMobileRequestedForDevScript({ args, env });

  const ownerRunning = Number.isFinite(existingOwnerPid) && existingOwnerPid > 1 ? isPidAlive(existingOwnerPid) : false;
  const serverPidRunning = Number.isFinite(existingServerPid) && existingServerPid > 1 ? isPidAlive(existingServerPid) : false;
  const expoPidRunning = Number.isFinite(existingExpoPid) && existingExpoPid > 1 ? isPidAlive(existingExpoPid) : false;
  const forwarderRunning =
    Number.isFinite(existingForwarderPid) && existingForwarderPid > 1 ? isPidAlive(existingForwarderPid) : false;
  const serverPortListening =
    Number.isFinite(existingServerPort) && existingServerPort > 0
      ? !(await isTcpPortFree(existingServerPort, { host: '127.0.0.1' }).catch(() => true))
      : false;
  const serverRunning = serverPortListening || serverPidRunning;

  let uiRunning = false;
  let uiPort = null;
  if (wantsUi || wantsMobile) {
    const base = String(baseDir ?? '').trim();
    if (base) {
      const res = await findRunningExpoStateInRoot({
        expoDevRoot: join(base, 'expo-dev'),
        requireWeb: wantsUi,
        expectedProjectDir: expectedUiDir,
      });
      const p = Number(res?.state?.port);
      if (res && Number.isFinite(p) && p > 0) {
        uiRunning = true;
        uiPort = p;
      }
    } else if (Number.isFinite(existingExpoPort) && existingExpoPort > 0) {
      uiRunning = await looksLikeExpoMetro({ port: existingExpoPort, timeoutMs: 900 });
      uiPort = uiRunning ? existingExpoPort : null;
    }
  }

  const wasRunning = ownerRunning || serverRunning || uiRunning || serverPidRunning || expoPidRunning || forwarderRunning;
  const canShortCircuit =
    scriptPath === 'dev.mjs'
      ? serverRunning && (!wantsUi || uiRunning) && (!wantsMobile || uiRunning)
      : wasRunning;

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

async function forceStopRecordedPid(pid) {
  const targetPid = Number(pid);
  if (!Number.isFinite(targetPid) || targetPid <= 1 || !isPidAlive(targetPid)) {
    return false;
  }

  const terminate = (signal) => {
    try {
      process.kill(-targetPid, signal);
      return true;
    } catch {
      try {
        process.kill(targetPid, signal);
        return true;
      } catch {
        return false;
      }
    }
  };

  terminate('SIGTERM');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!isPidAlive(targetPid)) {
      return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(100);
  }

  terminate('SIGKILL');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!isPidAlive(targetPid)) {
      return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(100);
  }

  return !isPidAlive(targetPid);
}

async function collectDaemonStatePids({ cliHomeDir, serverUrl, env }) {
  const pairs = resolveStackDaemonStatePaths({ cliHomeDir, serverUrl, env }).pairs ?? [];
  const statePaths = new Set(
    pairs
      .map((pair) => String(pair?.statePath ?? '').trim())
      .filter(Boolean),
  );
  try {
    const serverEntries = await readdir(join(cliHomeDir, 'servers'), { withFileTypes: true });
    for (const entry of serverEntries) {
      if (!entry.isDirectory()) continue;
      statePaths.add(join(cliHomeDir, 'servers', entry.name, 'daemon.state.json'));
    }
  } catch {
    // ignore missing or unreadable server-scoped daemon directories
  }
  const pids = [];

  for (const statePath of statePaths) {
    try {
      const parsed = JSON.parse(await readFileText(statePath, 'utf8'));
      const pid = Number(parsed?.pid);
      if (Number.isFinite(pid) && pid > 1) {
        pids.push(pid);
      }
    } catch {
      // ignore unreadable or missing daemon state files
    }
  }

  return [...new Set(pids)];
}

async function removeDaemonStateFiles({ cliHomeDir, serverUrl, env }) {
  const pairs = resolveStackDaemonStatePaths({ cliHomeDir, serverUrl, env }).pairs ?? [];
  const statePaths = new Set(
    pairs
      .flatMap((pair) => [pair?.statePath, pair?.lockPath])
      .map((path) => String(path ?? '').trim())
      .filter(Boolean),
  );
  try {
    const serverEntries = await readdir(join(cliHomeDir, 'servers'), { withFileTypes: true });
    for (const entry of serverEntries) {
      if (!entry.isDirectory()) continue;
      statePaths.add(join(cliHomeDir, 'servers', entry.name, 'daemon.state.json'));
      statePaths.add(join(cliHomeDir, 'servers', entry.name, 'daemon.state.json.lock'));
    }
  } catch {
    // ignore missing or unreadable server-scoped daemon directories
  }

  for (const path of statePaths) {
    // eslint-disable-next-line no-await-in-loop
    await rm(path, { force: true }).catch(() => {});
  }
}

async function cleanupFailedRestartAttempt({
  rootDir,
  stackName,
  baseDir,
  env,
  runtimeStatePath,
  wantsJson = false,
}) {
  const runtimeStateBeforeCleanup = runtimeStatePath ? await readStackRuntimeStateFile(runtimeStatePath) : null;
  const forcedRuntimePids = [
    Number(runtimeStateBeforeCleanup?.ownerPid),
    ...getStackRuntimeProcessEntries(runtimeStateBeforeCleanup).map(({ pid }) => Number(pid)),
  ].filter((pid, index, all) => Number.isFinite(pid) && pid > 1 && all.indexOf(pid) === index);
  const recordedDaemonPid = Number(runtimeStateBeforeCleanup?.processes?.daemonPid);
  const cliHomeDir = (env.HAPPIER_STACK_CLI_HOME_DIR ?? join(baseDir, 'cli')).toString();
  const serverPort = coercePort(env.HAPPIER_STACK_SERVER_PORT);
  const internalServerUrl = serverPort ? `http://127.0.0.1:${serverPort}` : 'http://127.0.0.1:3005';

  try {
    await stopStackWithEnv({
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
    });
  } catch {
    // Best-effort cleanup; preserve the original restart failure.
  }

  for (const pid of forcedRuntimePids) {
    if (!isPidAlive(pid)) continue;
    // eslint-disable-next-line no-await-in-loop
    await forceStopRecordedPid(pid).catch(() => {});
  }

  await stopLocalDaemon({
    cliBin: join(cliHomeDir, 'bin', 'happier.mjs'),
    internalServerUrl,
    cliHomeDir,
    env,
    runtimeStatePath,
  }).catch(() => {});

  const daemonStatePids = await collectDaemonStatePids({
    cliHomeDir,
    serverUrl: internalServerUrl,
    env,
  }).catch(() => []);
  for (const daemonPid of daemonStatePids) {
    // eslint-disable-next-line no-await-in-loop
    await forceStopRecordedPid(daemonPid).catch(() => {});
  }

  const hasLiveDaemonPid = [recordedDaemonPid, ...daemonStatePids].some((daemonPid) => isPidAlive(daemonPid));
  if (hasLiveDaemonPid) {
    await cleanupStaleDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env }).catch(() => {});
  } else {
    await removeDaemonStateFiles({
      cliHomeDir,
      serverUrl: internalServerUrl,
      env,
    }).catch(() => {});
  }

  if (!runtimeStatePath) {
    return;
  }
  const runtimeStateAfterCleanup = await readStackRuntimeStateFile(runtimeStatePath);
  const hasLiveTrackedProcesses = getStackRuntimeProcessEntries(runtimeStateAfterCleanup).some(({ pid }) => isPidAlive(pid));
  if (!hasLiveTrackedProcesses) {
    await deleteStackRuntimeStateFile(runtimeStatePath).catch(() => {});
  }
}

export async function runStackScriptWithStackEnv({ rootDir, stackName, scriptPath, args, extraEnv = {}, background = false }) {
  await withStackEnv({
    stackName,
    extraEnv,
    fn: async ({ env, envPath, stackEnv, runtimeStatePath, runtimeState }) => {
      const isStartLike = scriptPath === 'dev.mjs' || scriptPath === 'run.mjs';
      const wantsRestart = args.includes('--restart');
      const wantsJson = args.includes('--json');
      if (isStartLike && background && wantsJson) {
        // Dry-run JSON must never allocate ports, write runtime state, or wait for readiness.
        await run(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], { cwd: rootDir, env });
        return;
      }
      const { baseDir } = resolveStackEnvPath(stackName, env);
      const expectedUiDir = getComponentDir(rootDir, 'happier-ui', env);

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
        const existingUiPort = Number(runtimeState?.expo?.webPort);
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
        // - Stop stack-owned processes first (runner, daemon, Expo, etc.)
        // - Never kill arbitrary port listeners
        // - Preserve previous runtime ports in memory so a true restart can reuse them
        if (wantsRestart && !wantsJson) {
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
        if (existingRuntimeStatus.canShortCircuit) {
          if (!wantsRestart) {
          const serverPart = Number.isFinite(existingPort) && existingPort > 0 ? ` server=${existingPort}` : '';
          const uiPart =
            scriptPath === 'dev.mjs' && Number.isFinite(existingRuntimeStatus.uiPort) && existingRuntimeStatus.uiPort > 0
              ? ` ui=${existingRuntimeStatus.uiPort}`
              : scriptPath === 'dev.mjs' && Number.isFinite(existingUiPort) && existingUiPort > 0
              ? ` ui=${existingUiPort}`
              : '';
          console.log(`[stack] ${stackName}: already running (pid=${existingOwnerPid}${serverPart}${uiPart})`);

          const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
          const noBrowser = args.includes('--no-browser') || (env.HAPPIER_STACK_NO_BROWSER ?? '').toString().trim() === '1';
          const openBrowser = isInteractive && !wantsJson && !noBrowser;

          const host = resolveLocalhostHost({ stackMode: true, stackName });
          const uiUrl =
            scriptPath === 'dev.mjs'
              ? Number.isFinite(existingUiPort) && existingUiPort > 0
                ? `http://${host}:${existingUiPort}`
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
          } else if (scriptPath === 'dev.mjs') {
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

                // Last resort: if we can prove the listener is stack-owned, kill it.
                // eslint-disable-next-line no-await-in-loop
                const pids = await listListenPids(p);
                const stackBaseDir = resolveStackEnvPath(stackName).baseDir;
                const cliHomeDir = getCliHomeDirFromEnvOrDefault({ stackBaseDir, env });
                for (const pid of pids) {
                  // eslint-disable-next-line no-await-in-loop
                  await killProcessGroupOwnedByStack(pid, { stackName, envPath, cliHomeDir, label: `port:${p}`, json: false });
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
          const startUi = !args.includes('--no-ui') && (env.HAPPIER_STACK_SERVE_UI ?? '1').toString().trim() !== '0';
          const startDaemon = !args.includes('--no-daemon') && (env.HAPPIER_STACK_DAEMON ?? '1').toString().trim() !== '0';
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
        const logPath = join(logsDir, `${scriptPath.replace(/\.mjs$/, '')}.${Date.now()}.log`);
        if (background) {
          await ensureDir(logsDir);
        }

        let logHandle = null;
        let outFd = null;
        if (background) {
          logHandle = await open(logPath, 'a');
          outFd = logHandle.fd;
        }

        // Spawn the runner (long-lived) and record its pid + ports for other stack-scoped commands.
        const child = spawn(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], {
          cwd: rootDir,
          env: childEnv,
          stdio: background ? ['ignore', outFd ?? 'ignore', outFd ?? 'ignore'] : 'inherit',
          shell: false,
          detached: background && process.platform !== 'win32',
        });
        try {
          await logHandle?.close();
        } catch {
          // ignore
        }

        // Record the chosen ports immediately (before the runner finishes booting), so other stack commands
        // can resolve the correct endpoints and `--restart` can reliably reuse the same ports.
        await recordStackRuntimeStart(runtimeStatePath, {
          stackName,
          script: scriptPath,
          ephemeral: true,
          ownerPid: child.pid,
          ports,
          runtimeSnapshotId,
          ...(background ? { logs: { runner: logPath } } : {}),
        }).catch(() => {});

        if (background) {
          // Keep stack.runtime.json so stack-scoped stop/restart can manage this runner.
          // This mode is used by higher-level commands that want to run guided auth steps
          // without mixing them into server logs.
          const internalServerUrl = `http://127.0.0.1:${ports.server}`;

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
              await waitForHttpOk(`${internalServerUrl}/health`, {
                timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000,
                intervalMs: 300,
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
            // Best-effort cleanup on boot failure.
            try {
              // We spawned this runner process, so we can safely terminate it without relying
              // on ownership heuristics (which can be unreliable on some platforms due to `ps` truncation).
              if (background && process.platform !== 'win32') {
                try {
                  process.kill(-child.pid, 'SIGTERM');
                } catch {
                  // ignore
                }
              }
              try {
                child.kill('SIGTERM');
              } catch {
                // ignore
              }
            } catch {
              // ignore
            }
            if (!preservedDaemonForRestart) {
              await deleteStackRuntimeStateFile(runtimeStatePath).catch(() => {});
            }
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
          if (Number(cur?.ownerPid) === Number(child.pid)) {
            // Only delete runtime state when we're confident no child processes are left behind.
            // If the runner crashes but a child (server/expo/daemon) stays alive, keeping stack.runtime.json
            // allows `hstack stack stop --aggressive` to kill the recorded PIDs safely.
            const processes = cur?.processes && typeof cur.processes === 'object' ? cur.processes : {};
            const anyAlive = Object.values(processes)
              .map((p) => Number(p))
              .some((pid) => Number.isFinite(pid) && pid > 1 && isPidAlive(pid));
            const portRaw = cur?.ports && typeof cur.ports === 'object' ? cur.ports.server : null;
            const port = Number(portRaw);
            const portOccupied = Number.isFinite(port) && port > 0 ? !(await isTcpPortFree(port, { host: '127.0.0.1' }).catch(() => true)) : false;

            if (!anyAlive && !portOccupied) {
              await deleteStackRuntimeStateFile(runtimeStatePath);
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
        const logPath = join(logsDir, `${scriptPath.replace(/\.mjs$/, '')}.${Date.now()}.log`);
        await ensureDir(logsDir);

        const logHandle = await open(logPath, 'a');
        const outFd = logHandle.fd;

        const child = spawn(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], {
          cwd: rootDir,
          env,
          stdio: ['ignore', outFd ?? 'ignore', outFd ?? 'ignore'],
          shell: false,
          detached: process.platform !== 'win32',
        });
        try {
          await logHandle?.close();
        } catch {
          // ignore
        }

        await recordStackRuntimeStart(runtimeStatePath, {
          stackName,
          script: scriptPath,
          ephemeral: false,
          ownerPid: child.pid,
          ports: { server: pinnedPort },
          runtimeSnapshotId,
          logs: { runner: logPath },
        }).catch(() => {});

        const internalServerUrl = `http://127.0.0.1:${pinnedPort}`;
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
            await waitForHttpOk(`${internalServerUrl}/health`, {
              timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000,
              intervalMs: 300,
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
          try {
            if (process.platform !== 'win32') {
              try {
                process.kill(-child.pid, 'SIGTERM');
              } catch {
                // ignore
              }
            }
            try {
              child.kill('SIGTERM');
            } catch {
              // ignore
            }
          } catch {
            // ignore
          }
          if (!preservedDaemonForRestart) {
            await deleteStackRuntimeStateFile(runtimeStatePath).catch(() => {});
          }
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
        if (wantsRestart && !wantsJson) {
        const pinnedPort = coercePort(env.HAPPIER_STACK_SERVER_PORT);
        if (pinnedPort && !(await isTcpPortFree(pinnedPort))) {
          // Last resort: kill listener only if it is stack-owned.
          const pids = await listListenPids(pinnedPort);
          const stackBaseDir = resolveStackEnvPath(stackName).baseDir;
          const cliHomeDir = getCliHomeDirFromEnvOrDefault({ stackBaseDir, env });
          for (const pid of pids) {
            // eslint-disable-next-line no-await-in-loop
            await killProcessGroupOwnedByStack(pid, { stackName, envPath, cliHomeDir, label: `port:${pinnedPort}`, json: false });
          }
          if (!(await isTcpPortFree(pinnedPort))) {
            throw new Error(
              `[stack] ${stackName}: server port ${pinnedPort} is not free on restart.\n` +
                `[stack] Refusing to kill unknown listeners. Stop the process using it, or change the pinned port.`
            );
          }
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
            wantsJson,
          });
        }
        throw error;
      }
    },
  });
}
