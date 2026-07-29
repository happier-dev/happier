import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { getComponentDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { getEnvValueAny } from '../utils/env/values.mjs';
import { resolveLocalhostHost, preferStackLocalhostUrl } from '../utils/paths/localhost_host.mjs';
import { worktreeSpecFromDir } from '../utils/git/worktrees.mjs';
import { getStackRuntimeStatePath, isStackRuntimeProcessTrusted, readStackRuntimeStateFile, readStackServerLifecycle } from '../utils/stack/runtime_state.mjs';
import { readTextOrEmpty } from '../utils/fs/ops.mjs';
import { resolveDefaultRepoEnv } from './stack_environment.mjs';
import { resolveStackRuntimeMode } from '../runtime/shared/runtime_mode.mjs';
import { inspectActiveRuntimeSnapshot } from '../runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import { getObservedStackDaemonAsync, readStackRuntimeStateWithDaemonSync } from '../utils/stack/runtime_daemon_state.mjs';
import { applyStackActiveServerScopeEnv, applyStackDaemonLifecycleScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { resolveStackDaemonStartRequested } from '../utils/auth/daemon_gate.mjs';
import { join } from 'node:path';
import { checkDaemonStatePingAware } from '../daemon.mjs';
import { resolveVerifiedStackServerEndpoint, resolveVerifiedStackUiEndpoint } from '../utils/stack/verified_endpoints.mjs';
import { isTcpPortListening, listListenPidsWithStatus } from '../utils/net/ports.mjs';
import { createListenerOwnershipObservationScope } from '../utils/server/listener_ownership.mjs';
import { getProcessGroupId, isPidOwnedByStack } from '../utils/proc/ownership.mjs';

const readExistingEnv = readTextOrEmpty;

function normalizePid(value) {
  const pid = Number(value);
  return Number.isFinite(pid) && pid > 1 ? pid : null;
}

export async function resolveStackComponentRuntime({
  port,
  recordedPid,
  runtimePidAlive = false,
  stackName,
  envPath,
  cliHomeDir,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  isTcpPortListeningImpl = isTcpPortListening,
  isPidOwnedByStackImpl = isPidOwnedByStack,
  getProcessGroupIdImpl = getProcessGroupId,
  listenerObservationScope,
}) {
  const expectedPort = Number(port) > 0 ? Number(port) : null;
  const runtimePid = normalizePid(recordedPid);
  if (!expectedPort) {
    return {
      pid: runtimePid,
      running: Boolean(runtimePidAlive),
      pidAlive: Boolean(runtimePidAlive),
      portListening: false,
      listenerPids: [],
      ownedListenerPids: [],
      listenerDiscoverySupported: false,
      listenerDiscoveryStatus: 'unsupported',
      ownershipStatus: runtimePidAlive ? 'unverified' : 'not_owned',
    };
  }
  const listenerStatus = listenerObservationScope
    ? await listenerObservationScope.observe(expectedPort, {
        ...(runtimePidAlive && runtimePid ? { candidatePids: [runtimePid] } : {}),
      })
    : await listListenPidsWithStatusImpl(expectedPort, {
        ...(runtimePidAlive && runtimePid ? { candidatePids: [runtimePid] } : {}),
      }).catch(() => ({
        status: 'error', supported: true, pids: [], reason: 'listener-discovery-error',
      }));
  const listenerDiscoveryStatus = String(listenerStatus?.status ?? (listenerStatus?.supported ? 'ok' : 'unsupported'));
  const listenerPids = Array.from(new Set((listenerStatus?.pids ?? []).map(normalizePid).filter(Boolean)));
  const portListening = listenerPids.length > 0 || await isTcpPortListeningImpl(expectedPort, { host: '127.0.0.1' }).catch(() => false);
  const ownedListenerPids = [];
  for (const pid of listenerPids) {
    if (runtimePidAlive && pid === runtimePid) {
      ownedListenerPids.push(pid);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await isPidOwnedByStackImpl(pid, { stackName, envPath, cliHomeDir }).catch(() => false)) {
      ownedListenerPids.push(pid);
      continue;
    }
    if (runtimePidAlive && runtimePid) {
      // eslint-disable-next-line no-await-in-loop
      const [runtimePgid, listenerPgid] = await Promise.all([getProcessGroupIdImpl(runtimePid), getProcessGroupIdImpl(pid)]);
      if (runtimePgid && runtimePgid === runtimePid && listenerPgid === runtimePgid) ownedListenerPids.push(pid);
    }
  }
  const ownershipStatus = ownedListenerPids.length > 0
    ? 'owned'
    : listenerDiscoveryStatus === 'ok'
      ? 'not_owned'
      : runtimePidAlive && portListening
        ? 'unknown'
        : 'unverified';
  return {
    pid: ownedListenerPids[0] ?? runtimePid,
    running: ownedListenerPids.length > 0 || (ownershipStatus === 'unknown' && runtimePidAlive && portListening),
    pidAlive: Boolean(runtimePidAlive),
    portListening,
    listenerPids,
    ownedListenerPids,
    listenerDiscoverySupported: listenerStatus?.supported === true,
    listenerDiscoveryStatus,
    ownershipStatus,
  };
}

export async function readStackInfoSnapshot({
  rootDir,
  stackName,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  isTcpPortListeningImpl = isTcpPortListening,
  isPidOwnedByStackImpl = isPidOwnedByStack,
  getProcessGroupIdImpl = getProcessGroupId,
  listenerObservationTimeoutMs = 1_000,
}) {
  const baseDir = resolveStackEnvPath(stackName).baseDir;
  const envPath = resolveStackEnvPath(stackName).envPath;
  const envRaw = await readExistingEnv(envPath);
  const stackEnv = envRaw ? parseEnvToObject(envRaw) : {};
  const runtimeStatePath = getStackRuntimeStatePath(stackName);

  const serverComponent = getEnvValueAny(stackEnv, ['HAPPIER_STACK_SERVER_COMPONENT']) || 'happier-server-light';
  const stackRemote = getEnvValueAny(stackEnv, ['HAPPIER_STACK_STACK_REMOTE']) || 'upstream';

  const pinnedServerPortRaw = getEnvValueAny(stackEnv, ['HAPPIER_STACK_SERVER_PORT']);
  const pinnedServerPort = pinnedServerPortRaw ? Number(pinnedServerPortRaw) : null;
  const stackScopedEnv = applyStackDaemonLifecycleScopeEnv({
    env: applyStackActiveServerScopeEnv({
      env: { ...process.env, ...stackEnv },
      stackName,
      cliIdentity: 'default',
    }),
    stackName,
    cliIdentity: 'default',
  });
  const initialRuntimeState = await readStackRuntimeStateFile(runtimeStatePath);
  const initialRuntimePorts =
    initialRuntimeState?.ports && typeof initialRuntimeState.ports === 'object' ? initialRuntimeState.ports : {};
  const syncServerPort =
    Number.isFinite(pinnedServerPort) && pinnedServerPort > 0
      ? pinnedServerPort
      : Number(initialRuntimePorts?.server) > 0
        ? Number(initialRuntimePorts.server)
        : null;
  const runtimeState = await readStackRuntimeStateWithDaemonSync({
    runtimeStatePath,
    cliHomeDir: join(baseDir, 'cli'),
    internalServerUrl: Number.isFinite(syncServerPort) && syncServerPort > 0 ? `http://127.0.0.1:${syncServerPort}` : '',
    env: stackScopedEnv,
  }, {
    checkDaemonStateImpl: checkDaemonStatePingAware,
  });

  const runtimePorts = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : {};
  const serverPort =
    Number.isFinite(pinnedServerPort) && pinnedServerPort > 0
      ? pinnedServerPort
      : Number(runtimePorts?.server) > 0
        ? Number(runtimePorts.server)
        : null;
  const backendPort = Number(runtimePorts?.backend) > 0 ? Number(runtimePorts.backend) : null;
  const serverBackendPort = Number(runtimePorts?.serverBackend) > 0 ? Number(runtimePorts.serverBackend) : null;
  const serverProxy =
    runtimeState?.serverProxy && typeof runtimeState.serverProxy === 'object' ? runtimeState.serverProxy : null;
  const serverLifecycle = readStackServerLifecycle(runtimeState);
  const serveUiWanted = typeof runtimeState?.serveUi === 'boolean'
    ? runtimeState.serveUi
    : String(getEnvValueAny(stackEnv, ['HAPPIER_STACK_SERVE_UI']) ?? '1').trim() !== '0';
  const runtimeSnapshotId = String(runtimeState?.runtimeSnapshotId ?? '').trim();
  const runtimeBackedStart = Boolean(runtimeSnapshotId);
  const componentEnv = { ...process.env, ...stackEnv };
  const repoDir = getEnvValueAny(stackEnv, ['HAPPIER_STACK_REPO_DIR']) || resolveDefaultRepoEnv({ rootDir }).HAPPIER_STACK_REPO_DIR;
  const uiDir = getComponentDir(rootDir, 'happier-ui', componentEnv);
  const cliDir = getComponentDir(rootDir, 'happier-cli', componentEnv);
  const serverDir = getComponentDir(rootDir, serverComponent, componentEnv);
  const mobilePort =
    runtimeState?.expo && typeof runtimeState.expo === 'object' && Number(runtimeState.expo.mobilePort) > 0
      ? Number(runtimeState.expo.mobilePort)
      : null;
  const ownerPid = Number(runtimeState?.ownerPid);
  const proxyPid = Number(runtimeState?.processes?.proxyPid);
  const serverPid = Number(runtimeState?.processes?.serverPid);
  const serverBackendPid = Number(runtimeState?.processes?.serverBackendPid);
  const expoPid = Number(runtimeState?.processes?.expoPid);
  const expoTailscaleForwarderPid = Number(runtimeState?.processes?.expoTailscaleForwarderPid);
  const daemonExpected = resolveStackDaemonStartRequested({
    env: {
      HAPPIER_STACK_DAEMON: getEnvValueAny(stackEnv, ['HAPPIER_STACK_DAEMON']),
    },
  });
  const runtimeProcessTrustContext = { stackName, envPath, cliHomeDir: join(baseDir, 'cli') };
  const observedDaemon = await getObservedStackDaemonAsync({
    cliHomeDir: join(baseDir, 'cli'),
    internalServerUrl: Number.isFinite(serverPort) && serverPort > 0 ? `http://127.0.0.1:${serverPort}` : '',
    runtimeDaemonPid: runtimeState?.processes?.daemonPid ?? null,
    runtimeDaemonPids: runtimeState?.processes?.daemonPids ?? [],
    env: stackScopedEnv,
  }, {
    checkDaemonStateImpl: checkDaemonStatePingAware,
  });
  const daemonPid = Number(observedDaemon.pid);
  const daemonPidAlive = await isStackRuntimeProcessTrusted(daemonPid, {
    ...runtimeProcessTrustContext,
    key: observedDaemon.source === 'runtime_pid' ? 'daemonPids' : 'daemonPid',
  });
  const daemonRunning = observedDaemon.running === true && daemonPidAlive;

  const ownerAlive = await isStackRuntimeProcessTrusted(ownerPid, {
    ...runtimeProcessTrustContext,
    key: 'ownerPid',
  });
  const proxyPidAlive = await isStackRuntimeProcessTrusted(proxyPid, {
    ...runtimeProcessTrustContext,
    key: 'proxyPid',
  });
  const serverPidAlive = await isStackRuntimeProcessTrusted(serverPid, {
    ...runtimeProcessTrustContext,
    key: 'serverPid',
  });
  const serverBackendPidAlive = await isStackRuntimeProcessTrusted(serverBackendPid, {
    ...runtimeProcessTrustContext,
    key: 'serverBackendPid',
  });
  const expoPidAlive = await isStackRuntimeProcessTrusted(expoPid, {
    ...runtimeProcessTrustContext,
    key: 'expoPid',
  });
  const expoForwarderAlive = await isStackRuntimeProcessTrusted(expoTailscaleForwarderPid, {
    ...runtimeProcessTrustContext,
    key: 'expoTailscaleForwarderPid',
  });

  const serverRuntimePid = serverProxy?.mode === 'proxy' ? proxyPid : serverPid;
  const serverRuntimePidAlive = serverProxy?.mode === 'proxy' ? proxyPidAlive : serverPidAlive;
  const listenerObservationScope = createListenerOwnershipObservationScope({
    totalTimeoutMs: listenerObservationTimeoutMs,
    attemptTimeoutMs: listenerObservationTimeoutMs,
    retryInconclusive: false,
    listListenPidsWithStatusImpl,
  });
  const serverEndpoint = await resolveVerifiedStackServerEndpoint({ port: serverPort });
  const serverComponentRuntime = await resolveStackComponentRuntime({
    port: serverPort,
    recordedPid: serverRuntimePid,
    runtimePidAlive: serverRuntimePidAlive,
    stackName,
    envPath,
    cliHomeDir: join(baseDir, 'cli'),
    listListenPidsWithStatusImpl,
    isTcpPortListeningImpl,
    isPidOwnedByStackImpl,
    getProcessGroupIdImpl,
    listenerObservationScope,
  });
  const serverPortListening = serverComponentRuntime.portListening || serverEndpoint.portListening;
  const serverRunning =
    Number.isFinite(serverPort) && serverPort > 0
      ? serverComponentRuntime.running || serverEndpoint.running
      : serverPidAlive;
  const serverBackendEndpoint = await resolveVerifiedStackServerEndpoint({ port: serverBackendPort });
  const serverBackendRunning =
    Number.isFinite(serverBackendPort) && serverBackendPort > 0
      ? serverBackendEndpoint.running
      : serverBackendPidAlive;
  const uiEndpoint = await resolveVerifiedStackUiEndpoint({
    stackName,
    baseDir,
    runtimeState,
    expectedProjectDir: uiDir,
    serverPort,
    serverRunning,
    serveUiWanted,
    runtimeBackedStart,
  });
  const uiExpected = uiEndpoint.expected;
  const uiRunning = uiEndpoint.running;
  const uiPortListening = uiEndpoint.running;
  const uiPort = uiEndpoint.port;
  const uiPid = runtimeBackedStart ? (serveUiWanted ? serverPid : null) : expoPid;
  const uiPidAlive = runtimeBackedStart ? (serveUiWanted ? serverPidAlive : false) : expoPidAlive;
  const runningPid =
    [
      { pid: ownerPid, running: ownerAlive },
      { pid: proxyPid, running: proxyPidAlive },
      { pid: serverPid, running: serverPidAlive },
      { pid: serverBackendPid, running: serverBackendPidAlive },
      { pid: expoPid, running: expoPidAlive },
      { pid: expoTailscaleForwarderPid, running: expoForwarderAlive },
      { pid: daemonPid, running: daemonPidAlive },
    ].find(({ pid, running: pidRunning }) => pidRunning && Number.isFinite(pid) && pid > 1)?.pid ?? null;
  const running =
    ownerAlive ||
    serverRunning ||
    serverBackendRunning ||
    uiRunning ||
    daemonRunning ||
    daemonPidAlive ||
    proxyPidAlive ||
    serverPidAlive ||
    serverBackendPidAlive ||
    expoPidAlive ||
    expoForwarderAlive;

  const healthIssues = [];
  if (serverComponentRuntime.ownershipStatus === 'unknown') {
    healthIssues.push('ownership_unknown');
  } else if (
    serverLifecycle?.phase === 'unavailable'
    || (Number.isFinite(serverPort) && serverPort > 0 && !serverRunning)
  ) {
    healthIssues.push('server_down');
  }
  if (uiExpected && !uiRunning) {
    healthIssues.push('ui_down');
  }
  if (daemonExpected && running && !daemonRunning) {
    healthIssues.push('daemon_down');
  }
  const healthStatus = !running ? 'stopped' : healthIssues.length > 0 ? 'degraded' : 'healthy';

  const host = resolveLocalhostHost({ stackMode: true, stackName });
  const internalServerUrl = serverPort ? `http://127.0.0.1:${serverPort}` : null;
  const uiUrl = uiPort ? `http://${host}:${uiPort}` : null;
  const mobileUrl = mobilePort ? await preferStackLocalhostUrl(`http://localhost:${mobilePort}`, { stackName }) : null;

  const repoWorktreeSpec = repoDir ? worktreeSpecFromDir({ rootDir, component: 'happier-ui', dir: repoDir }) || null : null;
  const runtimeMode = resolveStackRuntimeMode({ argv: [], env: stackEnv }).mode;
  const runtimeInspection = await inspectActiveRuntimeSnapshot({ stackBaseDir: baseDir });
  const dirs = {
    repoDir,
    uiDir,
    cliDir,
    serverDir,
  };

  return {
    ok: true,
    stackName,
    baseDir,
    envPath,
    runtimeStatePath,
    serverComponent,
    stackRemote,
    pinned: {
      serverPort: Number.isFinite(pinnedServerPort) && pinnedServerPort > 0 ? pinnedServerPort : null,
    },
    runtime: {
      script: typeof runtimeState?.script === 'string' ? runtimeState.script : null,
      ownerPid: Number.isFinite(ownerPid) && ownerPid > 1 ? ownerPid : null,
      runningPid: Number.isFinite(runningPid) && runningPid > 1 ? runningPid : null,
      running,
      components: {
        owner: {
          pid: Number.isFinite(ownerPid) && ownerPid > 1 ? ownerPid : null,
          running: ownerAlive,
        },
        daemon: {
          pid: Number.isFinite(daemonPid) && daemonPid > 1 ? daemonPid : null,
          running: daemonRunning,
          pidAlive: daemonPidAlive,
          status: observedDaemon.status,
          source: observedDaemon.source,
        },
        server: {
          pid: Number.isFinite(serverRuntimePid) && serverRuntimePid > 1 ? serverRuntimePid : null,
          running: serverRunning,
          pidAlive: serverRuntimePidAlive,
          portListening: serverPortListening,
          listenerPids: serverComponentRuntime.listenerPids,
          ownedListenerPids: serverComponentRuntime.ownedListenerPids,
          listenerDiscoverySupported: serverComponentRuntime.listenerDiscoverySupported,
          listenerDiscoveryStatus: serverComponentRuntime.listenerDiscoveryStatus,
          ownershipStatus: serverComponentRuntime.ownershipStatus,
        },
        serverBackend: {
          pid: Number.isFinite(serverBackendPid) && serverBackendPid > 1 ? serverBackendPid : null,
          running: serverBackendRunning,
          pidAlive: serverBackendPidAlive,
          portListening: serverBackendEndpoint.portListening,
        },
        ui: {
          pid: Number.isFinite(uiPid) && uiPid > 1 ? uiPid : null,
          running: uiRunning,
          pidAlive: uiPidAlive,
          portListening: uiPortListening,
        },
        expoTailscaleForwarder: {
          pid: Number.isFinite(expoTailscaleForwarderPid) && expoTailscaleForwarderPid > 1 ? expoTailscaleForwarderPid : null,
          running: expoForwarderAlive,
        },
      },
      health: {
        status: healthStatus,
        issues: healthIssues,
      },
      ports: runtimePorts,
      serverProxy,
      serverLifecycle,
      expo: runtimeState?.expo ?? null,
      processes: runtimeState?.processes ?? null,
      startedAt: runtimeState?.startedAt ?? null,
      updatedAt: runtimeState?.updatedAt ?? null,
      mode: runtimeMode,
      activeSnapshotId: runtimeInspection.activeSnapshotId,
      snapshotPath: runtimeInspection.snapshotPath,
      sourceFingerprint: runtimeInspection.sourceFingerprint,
      valid: runtimeInspection.valid,
      errors: runtimeInspection.errors,
      snapshotComponents: runtimeInspection.manifest?.components ?? null,
    },
    urls: {
      host,
      internalServerUrl,
      uiUrl,
      mobileUrl,
    },
    ports: {
      server: serverPort,
      backend: backendPort,
      serverBackend: serverBackendPort,
      ui: uiPort,
      mobile: mobilePort,
    },
    repo: {
      dir: repoDir,
      worktreeSpec: repoWorktreeSpec,
    },
    dirs,
  };
}
