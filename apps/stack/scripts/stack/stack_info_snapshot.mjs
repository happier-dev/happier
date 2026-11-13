import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { getComponentDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { getEnvValueAny } from '../utils/env/values.mjs';
import { resolveLocalhostHost, preferStackLocalhostUrl } from '../utils/paths/localhost_host.mjs';
import { worktreeSpecFromDir } from '../utils/git/worktrees.mjs';
import {
  getStackRuntimeStatePath,
  isPidAlive,
  isUnverifiedProcessInstance,
  readStackRuntimeStateFile,
  readStackServerLifecycle,
} from '../utils/stack/runtime_state.mjs';
import { isTcpPortListening, listListenPidsWithStatus } from '../utils/net/ports.mjs';
import { createListenerOwnershipCommandScope, proveRecordedServerListener } from '../utils/server/listener_ownership.mjs';
import { getProcessGroupId, resolvePidStackOwnership } from '../utils/proc/ownership.mjs';
import { readTextOrEmpty } from '../utils/fs/ops.mjs';
import { resolveDefaultRepoEnv } from './stack_environment.mjs';
import { resolveStackRuntimeMode } from '../runtime/shared/runtime_mode.mjs';
import { inspectActiveRuntimeSnapshot } from '../runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import { getObservedStackDaemonAsync, readStackRuntimeStateWithDaemonSync } from '../utils/stack/runtime_daemon_state.mjs';
import { applyStackActiveServerScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { join } from 'node:path';
import { checkDaemonStatePingAware } from '../daemon.mjs';

const readExistingEnv = readTextOrEmpty;

function normalizePid(value) {
  const pid = Number(value);
  return Number.isFinite(pid) && pid > 1 ? pid : null;
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isFinite(port) && port > 0 ? port : null;
}

async function resolveStackComponentRuntime({
  port,
  recordedPid,
  stackName,
  envPath,
  cliHomeDir,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  isTcpPortListeningImpl = isTcpPortListening,
  getProcessGroupIdImpl = getProcessGroupId,
  listenerObservationScope,
  recordedIdentity = null,
  resolvePidStackOwnershipImpl = resolvePidStackOwnership,
  fetchReadyIdentityImpl,
}) {
  const expectedPort = normalizePort(port);
  const runtimePid = normalizePid(recordedPid);
  const runtimePidAlive = runtimePid ? isPidAlive(runtimePid) : false;

  if (!expectedPort) {
    return {
      pid: runtimePid,
      running: runtimePidAlive,
      pidAlive: runtimePidAlive,
      portListening: false,
      listenerPids: [],
      ownedListenerPids: [],
      listenerDiscoverySupported: false,
      listenerDiscoveryStatus: 'unsupported',
      ownershipStatus: runtimePidAlive ? 'unverified' : 'not_owned',
    };
  }

  const listenerStatus = listenerObservationScope
    ? await listenerObservationScope.observe(expectedPort)
    : await listListenPidsWithStatusImpl(expectedPort).catch(() => ({
        status: 'error',
        supported: true,
        pids: [],
        reason: 'listener-discovery-error',
      }));
  const listenerDiscoveryStatus = typeof listenerStatus?.status === 'string'
    ? listenerStatus.status
    : listenerStatus?.supported === true
      ? 'ok'
      : 'unsupported';
  const listenerPids = Array.from(
    new Set(
      (Array.isArray(listenerStatus?.pids) ? listenerStatus.pids : [])
        .map((pid) => normalizePid(pid))
        .filter(Boolean)
    )
  );
  const portListening =
    listenerPids.length > 0 ||
    (await isTcpPortListeningImpl(expectedPort, { host: '127.0.0.1' }).catch(() => false));

  // Every process on this port is judged here, inside the one command budget.
  const judgeProcess = async (pid, context = {}) => {
    const ownership = await listenerObservationScope.withProcessProbeBudget((budget) => resolvePidStackOwnershipImpl(
      pid,
      { stackName, envPath, cliHomeDir, ...context },
      budget,
    )).catch(() => null);
    if (!ownership || ownership.status === 'inconclusive') return 'unresolved';
    return ownership.owned === true ? 'owned' : 'foreign';
  };
  // A matching number proves nothing: the recorded process is judged by its identity, once.
  let recordedProcessVerdict = null;
  const judgeRecordedProcess = () => {
    if (isUnverifiedProcessInstance(recordedIdentity, runtimePid)) return 'unresolved';
    const fingerprint = Number(recordedIdentity?.pid) === runtimePid ? recordedIdentity?.fingerprint : null;
    recordedProcessVerdict ??= judgeProcess(runtimePid, fingerprint ? { processInstanceFingerprint: fingerprint } : {});
    return recordedProcessVerdict;
  };
  const judgeListener = async (pid) => {
    if (runtimePidAlive && pid === runtimePid) return await judgeRecordedProcess();
    const rowVerdict = await judgeProcess(pid);
    if (rowVerdict !== 'foreign' || !runtimePidAlive) return rowVerdict;
    // A shared process group only counts if its leader is still the recorded process.
    const leaderVerdict = await judgeRecordedProcess();
    if (leaderVerdict !== 'owned') return leaderVerdict;
    const groups = await listenerObservationScope.withProcessProbeBudget((budget) => Promise.all([
      getProcessGroupIdImpl(runtimePid, budget),
      getProcessGroupIdImpl(pid, budget),
    ])).catch(() => null);
    if (!Array.isArray(groups)) return 'unresolved';
    return groups[0] && groups[0] === runtimePid && groups[1] === groups[0] ? 'owned' : 'foreign';
  };

  // Ownership is a claim about everything on this port, so every row has to agree. Rows are judged
  // together: one after another, a stalled row would use up the budget and hide a foreign row.
  const listenerVerdicts = await Promise.all(listenerPids.map(async (pid) => ({
    pid,
    verdict: await judgeListener(pid),
  })));
  const hasForeignListener = listenerVerdicts.some(({ verdict }) => verdict === 'foreign');
  const hasUnresolvedListener = listenerVerdicts.some(({ verdict }) => verdict === 'unresolved');
  const ownedListenerPids = hasForeignListener || hasUnresolvedListener
    ? []
    : listenerVerdicts.map(({ pid }) => pid);

  // OS discovery concluded but listed nothing, yet something answers on this port. Only the
  // evidence that proved this server at startup, read again now, can say it is still that server.
  const recordedProof = listenerDiscoveryStatus === 'ok'
    && listenerPids.length === 0
    && portListening
    && runtimePidAlive
    && Number(recordedIdentity?.pid) === runtimePid
    && recordedIdentity?.fingerprint
    && recordedIdentity?.apiInstanceId
    ? await proveRecordedServerListener(
        { port: expectedPort, pid: runtimePid, identity: recordedIdentity, stackName, envPath, cliHomeDir },
        {
          observationScope: listenerObservationScope,
          resolvePidStackOwnershipImpl,
          ...(fetchReadyIdentityImpl ? { fetchReadyIdentityImpl } : {}),
        },
      )
    : null;
  if (recordedProof === 'proven') ownedListenerPids.push(runtimePid);

  const effectivePid = ownedListenerPids[0] ?? runtimePid;
  const effectivePidAlive = effectivePid ? isPidAlive(effectivePid) : false;
  const ownershipStatus = ownedListenerPids.length > 0
    ? 'owned'
    : hasForeignListener
      ? 'not_owned'
      : hasUnresolvedListener
        ? 'unknown'
        : listenerDiscoveryStatus === 'ok' && recordedProof !== 'inconclusive'
          ? 'not_owned'
          : runtimePidAlive && portListening
            ? 'unknown'
            : 'unverified';
  const running = ownedListenerPids.length > 0 || (ownershipStatus === 'unknown' && runtimePidAlive && portListening);

  return {
    pid: effectivePid,
    running,
    pidAlive: effectivePidAlive,
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
  getProcessGroupIdImpl = getProcessGroupId,
  resolvePidStackOwnershipImpl = resolvePidStackOwnership,
  listenerObservationTimeoutMs,
  getObservedStackDaemonImpl = getObservedStackDaemonAsync,
  fetchReadyIdentityImpl,
}) {
  const baseDir = resolveStackEnvPath(stackName).baseDir;
  const envPath = resolveStackEnvPath(stackName).envPath;
  const envRaw = await readExistingEnv(envPath);
  const stackEnv = envRaw ? parseEnvToObject(envRaw) : {};
  const daemonExpected = String(getEnvValueAny(stackEnv, ['HAPPIER_STACK_DAEMON']) ?? '1').trim() !== '0';
  const runtimeStatePath = getStackRuntimeStatePath(stackName);

  const serverComponent = getEnvValueAny(stackEnv, ['HAPPIER_STACK_SERVER_COMPONENT']) || 'happier-server-light';
  const stackRemote = getEnvValueAny(stackEnv, ['HAPPIER_STACK_STACK_REMOTE']) || 'upstream';

  const pinnedServerPortRaw = getEnvValueAny(stackEnv, ['HAPPIER_STACK_SERVER_PORT']);
  const pinnedServerPort = pinnedServerPortRaw ? Number(pinnedServerPortRaw) : null;
  const stackScopedEnv = applyStackActiveServerScopeEnv({
    env: {
      ...process.env,
      ...stackEnv,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
    },
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
  const runtimeState = daemonExpected
    ? await readStackRuntimeStateWithDaemonSync({
        runtimeStatePath,
        cliHomeDir: join(baseDir, 'cli'),
        internalServerUrl: Number.isFinite(syncServerPort) && syncServerPort > 0 ? `http://127.0.0.1:${syncServerPort}` : '',
        env: stackScopedEnv,
      }, {
        checkDaemonStateImpl: checkDaemonStatePingAware,
        resolvePidStackOwnershipImpl,
      })
    : initialRuntimeState;

  const runtimePorts = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : {};
  const serverPort =
    Number.isFinite(pinnedServerPort) && pinnedServerPort > 0
      ? pinnedServerPort
      : Number(runtimePorts?.server) > 0
        ? Number(runtimePorts.server)
        : null;
  const backendPort = Number(runtimePorts?.backend) > 0 ? Number(runtimePorts.backend) : null;
  const serverBackendPort = Number(runtimePorts?.serverBackend) > 0 ? Number(runtimePorts.serverBackend) : null;
  const serveUiWanted = typeof runtimeState?.serveUi === 'boolean'
    ? runtimeState.serveUi
    : String(getEnvValueAny(stackEnv, ['HAPPIER_STACK_SERVE_UI']) ?? '1').trim() !== '0';
  const runtimeSnapshotId = String(runtimeState?.runtimeSnapshotId ?? '').trim();
  const runtimeBackedStart = Boolean(runtimeSnapshotId);
  const expoUiPort =
    runtimeState?.expo && typeof runtimeState.expo === 'object' && Number(runtimeState.expo.webPort) > 0
      ? Number(runtimeState.expo.webPort)
      : null;
  const uiPort = runtimeBackedStart ? (serveUiWanted ? serverPort : null) : expoUiPort;
  const mobilePort =
    runtimeState?.expo && typeof runtimeState.expo === 'object' && Number(runtimeState.expo.mobilePort) > 0
      ? Number(runtimeState.expo.mobilePort)
      : null;
  const ownerPid = normalizePid(runtimeState?.ownerPid);
  const serverProxy =
    runtimeState?.serverProxy && typeof runtimeState.serverProxy === 'object' ? runtimeState.serverProxy : null;
  const serverLifecycle = readStackServerLifecycle(runtimeState);
  const proxyMode = String(serverProxy?.mode ?? '').trim();
  const serverPid = normalizePid(runtimeState?.processes?.serverPid);
  const proxyPid = normalizePid(runtimeState?.processes?.proxyPid);
  const serverBackendPid = normalizePid(runtimeState?.processes?.serverBackendPid);
  const serverDrainingPid = normalizePid(runtimeState?.processes?.serverDrainingPid);
  const expoPid = normalizePid(runtimeState?.processes?.expoPid);
  const expoTailscaleForwarderPid = normalizePid(runtimeState?.processes?.expoTailscaleForwarderPid);
  const cliHomeDir = join(baseDir, 'cli');
  const observedDaemon = daemonExpected
    ? await getObservedStackDaemonImpl({
        cliHomeDir,
        internalServerUrl: Number.isFinite(serverPort) && serverPort > 0 ? `http://127.0.0.1:${serverPort}` : '',
        runtimeDaemonPid: runtimeState?.processes?.daemonPid ?? null,
        runtimeDaemonPids: runtimeState?.processes?.daemonPids ?? [],
        env: stackScopedEnv,
      }, {
        checkDaemonStateImpl: checkDaemonStatePingAware,
      })
    : { pid: null, running: false, status: 'disabled', source: 'config' };
  const daemonPid = normalizePid(observedDaemon.pid);
  const daemonRunning = observedDaemon.running === true;
  const daemonPidAlive = daemonPid ? isPidAlive(daemonPid) : false;

  const ownerAlive = ownerPid ? isPidAlive(ownerPid) : false;
  const serverRuntimePid = proxyMode === 'proxy' ? proxyPid : serverPid;
  // Created here so the budget covers listener evidence only: its deadline starts at creation, and
  // the daemon work above can take longer than the whole budget.
  const listenerObservationScope = createListenerOwnershipCommandScope({
    listListenPidsWithStatusImpl,
    ...(listenerObservationTimeoutMs
      ? { totalTimeoutMs: listenerObservationTimeoutMs, attemptTimeoutMs: listenerObservationTimeoutMs }
      : {}),
  });
  const recordedIdentities = runtimeState?.processInstances?.processes ?? {};
  const recordedProofDependencies = { resolvePidStackOwnershipImpl, fetchReadyIdentityImpl };
  const serverComponentRuntime = await resolveStackComponentRuntime({
    port: serverPort,
    recordedPid: serverRuntimePid,
    recordedIdentity: recordedIdentities[proxyMode === 'proxy' ? 'proxyPid' : 'serverPid'],
    ...recordedProofDependencies,
    stackName,
    envPath,
    cliHomeDir,
    listListenPidsWithStatusImpl,
    isTcpPortListeningImpl,
    getProcessGroupIdImpl,
    listenerObservationScope,
  });
  const serverBackendComponentRuntime = await resolveStackComponentRuntime({
    port: serverBackendPort,
    recordedPid: serverBackendPid,
    recordedIdentity: recordedIdentities.serverBackendPid,
    ...recordedProofDependencies,
    stackName,
    envPath,
    cliHomeDir,
    listListenPidsWithStatusImpl,
    isTcpPortListeningImpl,
    getProcessGroupIdImpl,
    listenerObservationScope,
  });
  const uiComponentRuntime = runtimeBackedStart
    ? serveUiWanted
      ? serverComponentRuntime
      : await resolveStackComponentRuntime({
          port: null,
          recordedPid: null,
          stackName,
          envPath,
          cliHomeDir,
          listListenPidsWithStatusImpl,
          isTcpPortListeningImpl,
          getProcessGroupIdImpl,
          listenerObservationScope,
        })
    : await resolveStackComponentRuntime({
        port: expoUiPort,
        recordedPid: expoPid,
        recordedIdentity: recordedIdentities.expoPid,
        ...recordedProofDependencies,
        stackName,
        envPath,
        cliHomeDir,
        listListenPidsWithStatusImpl,
        isTcpPortListeningImpl,
        getProcessGroupIdImpl,
        listenerObservationScope,
      });
  const serverPidAlive = serverPid ? isPidAlive(serverPid) : false;
  const proxyPidAlive = proxyPid ? isPidAlive(proxyPid) : false;
  const serverBackendPidAlive = serverBackendPid ? isPidAlive(serverBackendPid) : false;
  const serverDrainingPidAlive = serverDrainingPid ? isPidAlive(serverDrainingPid) : false;
  const expoPidAlive = expoPid ? isPidAlive(expoPid) : false;
  const expoForwarderAlive = expoTailscaleForwarderPid ? isPidAlive(expoTailscaleForwarderPid) : false;

  const candidateRuntimePids = [
    ownerPid,
    serverComponentRuntime.pid,
    serverBackendComponentRuntime.pid,
    uiComponentRuntime.pid,
    serverPid,
    proxyPid,
    serverBackendPid,
    serverDrainingPid,
    expoPid,
    expoTailscaleForwarderPid,
    daemonPid,
  ].filter((pid) => Number.isFinite(pid) && pid > 1);
  const runningPid = candidateRuntimePids.find((pid) => isPidAlive(pid)) ?? null;
  const running =
    ownerAlive ||
    serverComponentRuntime.running ||
    serverBackendComponentRuntime.running ||
    uiComponentRuntime.running ||
    daemonRunning ||
    daemonPidAlive ||
    serverPidAlive ||
    proxyPidAlive ||
    serverBackendPidAlive ||
    serverDrainingPidAlive ||
    expoPidAlive ||
    expoForwarderAlive;

  const healthIssues = [];
  if (serverComponentRuntime.ownershipStatus === 'unknown') {
    healthIssues.push('ownership_unknown');
  } else if (Number.isFinite(serverPort) && serverPort > 0 && !serverComponentRuntime.running) {
    healthIssues.push('server_down');
  }
  if (proxyMode === 'proxy' && Number.isFinite(serverBackendPort) && serverBackendPort > 0 && !serverBackendComponentRuntime.running) {
    healthIssues.push('server_backend_down');
  }
  if (Number.isFinite(uiPort) && uiPort > 0 && !uiComponentRuntime.running) {
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

  const repoDir = getEnvValueAny(stackEnv, ['HAPPIER_STACK_REPO_DIR']) || resolveDefaultRepoEnv({ rootDir }).HAPPIER_STACK_REPO_DIR;
  const repoWorktreeSpec = repoDir ? worktreeSpecFromDir({ rootDir, component: 'happier-ui', dir: repoDir }) || null : null;
  const runtimeMode = resolveStackRuntimeMode({ argv: [], env: stackEnv }).mode;
  const runtimeInspection = await inspectActiveRuntimeSnapshot({ stackBaseDir: baseDir });
  const dirs = {
    repoDir,
    uiDir: getComponentDir(rootDir, 'happier-ui', { ...process.env, ...stackEnv }),
    cliDir: getComponentDir(rootDir, 'happier-cli', { ...process.env, ...stackEnv }),
    serverDir: getComponentDir(rootDir, serverComponent, { ...process.env, ...stackEnv }),
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
          pid: serverComponentRuntime.pid,
          running: serverComponentRuntime.running,
          pidAlive: serverComponentRuntime.pidAlive,
          portListening: serverComponentRuntime.portListening,
          listenerPids: serverComponentRuntime.listenerPids,
          ownedListenerPids: serverComponentRuntime.ownedListenerPids,
          listenerDiscoverySupported: serverComponentRuntime.listenerDiscoverySupported,
          listenerDiscoveryStatus: serverComponentRuntime.listenerDiscoveryStatus,
          ownershipStatus: serverComponentRuntime.ownershipStatus,
        },
        serverBackend: {
          pid: serverBackendComponentRuntime.pid,
          running: serverBackendComponentRuntime.running,
          pidAlive: serverBackendComponentRuntime.pidAlive,
          portListening: serverBackendComponentRuntime.portListening,
          listenerPids: serverBackendComponentRuntime.listenerPids,
          ownedListenerPids: serverBackendComponentRuntime.ownedListenerPids,
          listenerDiscoverySupported: serverBackendComponentRuntime.listenerDiscoverySupported,
          listenerDiscoveryStatus: serverBackendComponentRuntime.listenerDiscoveryStatus,
          ownershipStatus: serverBackendComponentRuntime.ownershipStatus,
        },
        ui: {
          pid: uiComponentRuntime.pid,
          running: uiComponentRuntime.running,
          pidAlive: uiComponentRuntime.pidAlive,
          portListening: uiComponentRuntime.portListening,
          listenerPids: uiComponentRuntime.listenerPids,
          ownedListenerPids: uiComponentRuntime.ownedListenerPids,
          listenerDiscoverySupported: uiComponentRuntime.listenerDiscoverySupported,
          listenerDiscoveryStatus: uiComponentRuntime.listenerDiscoveryStatus,
          ownershipStatus: uiComponentRuntime.ownershipStatus,
        },
        expoTailscaleForwarder: {
          pid: expoTailscaleForwarderPid,
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
