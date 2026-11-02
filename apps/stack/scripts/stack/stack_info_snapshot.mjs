import { observeRemoteSourceRuntime as readRemoteSourceRuntime } from './remote_source_runtime.mjs';
import { resolveInstalledFirstPartyComponentPaths } from '@happier-dev/cli-common/firstPartyRuntime';
import { realpath } from 'node:fs/promises';
import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { getComponentDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { getEnvValueAny } from '../utils/env/values.mjs';
import { resolveLocalhostHost, preferStackLocalhostUrl } from '../utils/paths/localhost_host.mjs';
import { worktreeSpecFromDir } from '../utils/git/worktrees.mjs';
import {
  getStackRuntimeStatePath,
  getStackRuntimePendingRemoteTargets,
  hasTrustedStackRuntimeLifecycle,
  isStackRuntimeProcessTrusted,
  readStackRuntimeStateFile,
  readStackServerLifecycle,
} from '../utils/stack/runtime_state.mjs';
import { readTextOrEmpty } from '../utils/fs/ops.mjs';
import { resolveDefaultRepoEnv } from './stack_environment.mjs';
import { resolveStackRuntimeMode } from '../runtime/shared/runtime_mode.mjs';
import { inspectStackRuntimeSelection } from '../runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import { resolveStackServerEndpoint } from '../utils/server/urls.mjs';
import { getObservedStackDaemonAsync, readStackRuntimeStateWithDaemonSync } from '../utils/stack/runtime_daemon_state.mjs';
import { applyStackActiveServerScopeEnv, applyStackDaemonLifecycleScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { resolveStackDaemonStartRequested } from '../utils/auth/daemon_gate.mjs';
import { join } from 'node:path';
import { checkDaemonStatePingAware } from '../daemon.mjs';
import { resolveVerifiedStackServerEndpoint, resolveVerifiedStackUiEndpoint } from '../utils/stack/verified_endpoints.mjs';
import { isTcpPortListening, listListenPidsWithStatus } from '../utils/net/ports.mjs';
import { createListenerOwnershipObservationScope, STACK_LISTENER_OBSERVATION_TIMEOUT_MS } from '../utils/server/listener_ownership.mjs';
import { getProcessGroupId, isPidOwnedByStack } from '../utils/proc/ownership.mjs';
import { resolveRuntimeRemoteServiceObservation } from '../utils/tui/runtime_placement_summary.mjs';
import { buildBorrowedExpoUiUrl, isBorrowedExpoConsumer, resolveBorrowedExpoRuntime, resolveSourceQaUiMode } from '../runtime/shared/borrowed_expo.mjs';
import { inspectWorkspaceQaStalePackagesForComponent } from '../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { readJsonIfExists } from '../utils/fs/json.mjs';
import { readPendingSourcePreparation } from '../runtime/shared/pending_source_start.mjs';

const readExistingEnv = readTextOrEmpty;

async function readManagedCliIdentity(env) {
  try {
    const paths = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', processEnv: env });
    const binaryPath = await realpath(paths.resolvedBinaryPath ?? paths.binaryPath);
    return { status: 'installed', binaryPath };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'absent' : 'unavailable', binaryPath: null };
  }
}

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
    running: ownedListenerPids.length > 0,
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
  observeRemoteSourceRuntime = true,
  synchronizeDaemonState = true,
  runRemoteProcessImpl,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  isTcpPortListeningImpl = isTcpPortListening,
  isPidOwnedByStackImpl = isPidOwnedByStack,
  getProcessGroupIdImpl = getProcessGroupId,
  listenerObservationTimeoutMs = STACK_LISTENER_OBSERVATION_TIMEOUT_MS,
  resolveBorrowedExpoRuntimeImpl = resolveBorrowedExpoRuntime,
}) {
  const baseDir = resolveStackEnvPath(stackName).baseDir;
  const envPath = resolveStackEnvPath(stackName).envPath;
  const envRaw = await readExistingEnv(envPath);
  const stackEnv = envRaw ? parseEnvToObject(envRaw) : {};
  const runtimeStatePath = getStackRuntimeStatePath(stackName);

  const serverComponent = getEnvValueAny(stackEnv, ['HAPPIER_STACK_SERVER_COMPONENT']) || 'happier-server-light';
  const stackRemote = getEnvValueAny(stackEnv, ['HAPPIER_STACK_STACK_REMOTE']) || 'upstream';
  const borrowedExpoProducerStackName = getEnvValueAny(stackEnv, ['HAPPIER_STACK_EXPO_SOURCE_STACK']);

  const pinnedServerPortRaw = getEnvValueAny(stackEnv, ['HAPPIER_STACK_SERVER_PORT']);
  const pinnedServerPort = pinnedServerPortRaw ? Number(pinnedServerPortRaw) : null;
  const stackScopedEnv = applyStackDaemonLifecycleScopeEnv({
    env: applyStackActiveServerScopeEnv({
      env: {
        ...process.env, ...stackEnv,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
        HAPPIER_STACK_CLI_HOME_DIR: stackEnv.HAPPIER_STACK_CLI_HOME_DIR || join(baseDir, 'cli'),
      },
      stackName,
      cliIdentity: 'default',
    }),
    stackName,
    cliIdentity: 'default',
  });
  const initialRuntimeState = await readStackRuntimeStateFile(runtimeStatePath);
  const runtimeProcessTrustContext = { stackName, envPath, cliHomeDir: join(baseDir, 'cli') };
  const runtimeStatusTrustOptions = { throwOnInconclusive: false };
  // Reconciliation and presentation consume the same daemon transport evidence
  // for this snapshot. A new snapshot creates a fresh observation.
  let daemonStateObservation;
  const observeDaemonState = (cliHomeDir, options) => (
    daemonStateObservation ??= Promise.resolve().then(() => checkDaemonStatePingAware(cliHomeDir, options))
  );
  const endpoint = await resolveStackServerEndpoint({ env: stackScopedEnv, stackName,
    runtimeState: initialRuntimeState, defaultPort: null, trustOptions: runtimeStatusTrustOptions });
  const trustedRuntimeServerPort = endpoint.runtimePort;
  const initialDaemonPlacement = String(initialRuntimeState?.placement?.daemon ?? '').trim();
  let runtimeState = !synchronizeDaemonState || (initialDaemonPlacement && initialDaemonPlacement !== 'local')
    ? initialRuntimeState
    : await readStackRuntimeStateWithDaemonSync({
        runtimeStatePath,
        cliHomeDir: join(baseDir, 'cli'),
        internalServerUrl: trustedRuntimeServerPort || endpoint.publicServerUrl ? endpoint.internalServerUrl : '',
        env: stackScopedEnv,
      }, {
        checkDaemonStateImpl: observeDaemonState,
      });

  if (observeRemoteSourceRuntime) {
    runtimeState = await readRemoteSourceRuntime({ stackName, baseDir, runtimeState, env: stackScopedEnv },
      { runProcess: runRemoteProcessImpl });
  }

  const runtimePorts = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : {};
  const serverPort = endpoint.port;
  const backendPort = Number(runtimePorts?.backend) > 0 ? Number(runtimePorts.backend) : null;
  const serverBackendPort = Number(runtimePorts?.serverBackend) > 0 ? Number(runtimePorts.serverBackend) : null;
  const serverProxy =
    runtimeState?.serverProxy && typeof runtimeState.serverProxy === 'object' ? runtimeState.serverProxy : null;
  const serverLifecycle = readStackServerLifecycle(runtimeState);
  const runtimePublication =
    runtimeState?.runtimePublication && typeof runtimeState.runtimePublication === 'object'
      ? runtimeState.runtimePublication
      : null;
  const serveUiConfigured = typeof runtimeState?.serveUi === 'boolean'
    ? runtimeState.serveUi
    : String(getEnvValueAny(stackEnv, ['HAPPIER_STACK_SERVE_UI']) ?? '1').trim() !== '0';
  const runtimeSnapshotId = String(runtimeState?.runtimeSnapshotId ?? '').trim();
  const sourceSnapshot = Boolean(runtimeState?.sourceRuntimeIdentities)
    || resolveStackRuntimeMode({ env: stackEnv }).mode === 'source-snapshot';
  // Dev producers also publish source identities; they own their Expo rather
  // than consuming the source-QA borrowed/export selection.
  const devExpoUi = sourceSnapshot && runtimeState?.script === 'dev.mjs';
  const sourceUi = sourceSnapshot && !devExpoUi ? resolveSourceQaUiMode({
    uiMode: runtimeState?.sourceUi === 'disabled' ? undefined : runtimeState?.sourceUi ?? undefined,
    noUi: runtimeState?.sourceUi === 'disabled' || (runtimeState?.sourceUi == null && !serveUiConfigured),
    consumerStackName: stackName, producerStackName: borrowedExpoProducerStackName,
  }) : null;
  const serveUiWanted = sourceUi !== null ? sourceUi === 'export' : serveUiConfigured;
  const runtimeBackedStart = Boolean(runtimeSnapshotId || sourceSnapshot);
  const serverServedUi = runtimeBackedStart && !devExpoUi;
  const componentEnv = { ...process.env, ...stackEnv };
  const repoDir = getEnvValueAny(stackEnv, ['HAPPIER_STACK_REPO_DIR']) || resolveDefaultRepoEnv({ rootDir }).HAPPIER_STACK_REPO_DIR;
  const uiDir = getComponentDir(rootDir, 'happier-ui', componentEnv);
  const cliDir = getComponentDir(rootDir, 'happier-cli', componentEnv);
  const serverDir = getComponentDir(rootDir, serverComponent, componentEnv);
  const ownedMobilePort =
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
  const observedDaemon = await getObservedStackDaemonAsync({
    cliHomeDir: join(baseDir, 'cli'),
    stackName,
    internalServerUrl: trustedRuntimeServerPort || endpoint.publicServerUrl ? endpoint.internalServerUrl : '',
    runtimeDaemonPid: runtimeState?.processes?.daemonPid ?? null,
    runtimeDaemonPids: runtimeState?.processes?.daemonPids ?? [],
    env: stackScopedEnv,
  }, {
    checkDaemonStateImpl: observeDaemonState,
  });
  const daemonPid = Number(observedDaemon.pid);
  const daemonPidAlive = await isStackRuntimeProcessTrusted(daemonPid, {
    ...runtimeProcessTrustContext,
    key: observedDaemon.source === 'runtime_pid' ? 'daemonPids' : 'daemonPid',
  }, runtimeStatusTrustOptions);
  const daemonRunning = observedDaemon.running === true && daemonPidAlive;
  const runtimePlacement = runtimeState?.placement && typeof runtimeState.placement === 'object'
    ? runtimeState.placement
    : {};
  const remoteTargets = runtimeState?.remoteTargets && typeof runtimeState.remoteTargets === 'object'
    ? runtimeState.remoteTargets
    : {};
  const remoteDaemon = resolveRuntimeRemoteServiceObservation(runtimeState, 'daemon');
  const remoteDaemonRunning = remoteDaemon.running;
  // The target lifecycle reports retry/preparation, not proof of native exit.
  const remoteDaemonUnknown = Boolean(remoteDaemon.target
    && !remoteDaemonRunning && !['stopped', 'not-running'].includes(remoteDaemon.status));
  const remoteExpo = resolveRuntimeRemoteServiceObservation(runtimeState, 'expo');
  const remoteServer = resolveRuntimeRemoteServiceObservation(runtimeState, 'server');
  const sourceUiLaunch = sourceUi === 'export'
    ? runtimeState?.sourceUiLaunch ?? remoteTargets[remoteServer.target]?.sourceUiLaunch ?? null : null;

  const ownerAlive = await isStackRuntimeProcessTrusted(ownerPid, {
    ...runtimeProcessTrustContext,
    key: 'ownerPid',
  }, runtimeStatusTrustOptions);
  const proxyPidAlive = await isStackRuntimeProcessTrusted(proxyPid, {
    ...runtimeProcessTrustContext,
    key: 'proxyPid',
  }, runtimeStatusTrustOptions);
  const serverPidAlive = await isStackRuntimeProcessTrusted(serverPid, {
    ...runtimeProcessTrustContext,
    key: 'serverPid',
  }, runtimeStatusTrustOptions);
  const serverBackendPidAlive = await isStackRuntimeProcessTrusted(serverBackendPid, {
    ...runtimeProcessTrustContext,
    key: 'serverBackendPid',
  }, runtimeStatusTrustOptions);
  const expoPidAlive = await isStackRuntimeProcessTrusted(expoPid, {
    ...runtimeProcessTrustContext,
    key: 'expoPid',
  }, runtimeStatusTrustOptions);
  const expoForwarderAlive = await isStackRuntimeProcessTrusted(expoTailscaleForwarderPid, {
    ...runtimeProcessTrustContext,
    key: 'expoTailscaleForwarderPid',
  }, runtimeStatusTrustOptions);

  const serverRuntimePid = serverProxy?.mode === 'proxy' ? proxyPid : serverPid;
  const serverRuntimePidAlive = serverProxy?.mode === 'proxy' ? proxyPidAlive : serverPidAlive;
  const serverEndpoint = await resolveVerifiedStackServerEndpoint({ port: trustedRuntimeServerPort });
  const listenerObservationScope = createListenerOwnershipObservationScope({
    totalTimeoutMs: listenerObservationTimeoutMs,
    attemptTimeoutMs: listenerObservationTimeoutMs,
    retryInconclusive: false,
    listListenPidsWithStatusImpl,
  });
  const recordedRuntimeServerPort = Number(runtimePorts?.server) > 0
    ? Number(runtimePorts.server)
    : null;
  // The fast trust probe may be inconclusive on a loaded host. Preserve the recorded runtime port
  // as a candidate for the bounded ownership observation below; it is projected only when that
  // observation proves the recorded stack process owns the listener.
  const serverObservationPort = trustedRuntimeServerPort ?? recordedRuntimeServerPort ?? serverPort;
  const serverComponentRuntime = await resolveStackComponentRuntime({
    port: serverObservationPort,
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
  const verifiedProxyEndpoint = (
    serverProxy?.mode === 'proxy'
    && serverComponentRuntime.ownershipStatus === 'owned'
    && !serverEndpoint.running
  )
    ? await resolveVerifiedStackServerEndpoint({ port: serverObservationPort })
    : serverEndpoint;
  const serverPortListening = serverComponentRuntime.portListening || serverEndpoint.portListening;
  const serverRunning =
    Number.isFinite(serverObservationPort) && serverObservationPort > 0
      ? serverComponentRuntime.running || serverEndpoint.running
      : serverPidAlive;
  const activeServerPort = serverRunning ? serverObservationPort : null;
  const serverBackendRuntime = await resolveStackComponentRuntime({
    port: serverBackendPort,
    recordedPid: serverBackendPid,
    runtimePidAlive: serverBackendPidAlive,
    stackName,
    envPath,
    cliHomeDir: join(baseDir, 'cli'),
    listListenPidsWithStatusImpl,
    isTcpPortListeningImpl,
    isPidOwnedByStackImpl,
    getProcessGroupIdImpl,
    listenerObservationScope,
  });
  const serverBackendRunning = serverBackendRuntime.running;
  const uiEndpoint = await resolveVerifiedStackUiEndpoint({
    stackName,
    baseDir,
    runtimeState,
    expectedProjectDir: uiDir,
    serverPort: activeServerPort,
    serverRunning,
    serveUiWanted,
    runtimeBackedStart: serverServedUi,
    requireExpoOwnership: false,
  });
  const borrowedExpo = (sourceUi === null || sourceUi === 'borrowed') && isBorrowedExpoConsumer({
    consumerStackName: stackName,
    producerStackName: borrowedExpoProducerStackName,
  })
    ? await resolveBorrowedExpoRuntimeImpl({
        rootDir,
        producerStackName: borrowedExpoProducerStackName,
        env: componentEnv,
      })
    : null;
  const borrowedUi = sourceUi === 'borrowed' || Boolean(borrowedExpo);
  const uiExpected = borrowedUi ? true : uiEndpoint.expected;
  const uiRunning = borrowedUi ? borrowedExpo?.running === true : uiEndpoint.running;
  const uiPortListening = borrowedUi ? uiRunning : uiEndpoint.running;
  const uiPort = borrowedExpo?.running ? borrowedExpo.port : borrowedUi ? null : uiEndpoint.port;
  const mobilePort = borrowedExpo?.running ? borrowedExpo.mobilePort : borrowedUi ? null : ownedMobilePort;
  const uiPid = borrowedUi ? null : serverServedUi ? (serveUiWanted ? serverPid : null) : expoPid;
  const uiPidAlive = borrowedUi ? false : serverServedUi ? (serveUiWanted ? serverPidAlive : false) : expoPidAlive;
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
    (!borrowedExpo && uiRunning) ||
    daemonRunning ||
    remoteDaemonRunning ||
    remoteServer.running ||
    daemonPidAlive ||
    proxyPidAlive ||
    serverPidAlive ||
    serverBackendPidAlive ||
    expoPidAlive ||
    expoForwarderAlive;

  const healthIssues = [];
  const stopCleanupIncomplete = Boolean(runtimeState?.stopRequest)
    || getStackRuntimePendingRemoteTargets(runtimeState).some(([, state]) => state.status === 'retirement-pending'
      || (state.phase === 'stop' && state.status === 'failed'));
  if (stopCleanupIncomplete) healthIssues.push('stop_cleanup_incomplete');
  const proxyBackendUnavailable = Boolean(
    serverProxy?.mode === 'proxy'
    && !serverBackendRunning
    && !verifiedProxyEndpoint.running,
  );
  if (serverComponentRuntime.ownershipStatus === 'unknown') {
    healthIssues.push('ownership_unknown');
  } else if (
    serverLifecycle?.phase === 'unavailable'
    || proxyBackendUnavailable
    || (Number.isFinite(serverPort) && serverPort > 0 && !serverRunning)
  ) {
    healthIssues.push('server_down');
  }
  if (uiExpected && !uiRunning) {
    healthIssues.push('ui_down');
  }
  if (daemonExpected && (running || remoteDaemonUnknown) && !daemonRunning && !remoteDaemonRunning) {
    healthIssues.push(remoteDaemonUnknown ? 'daemon_unknown' : 'daemon_down');
  }

  const host = resolveLocalhostHost({ stackMode: true, stackName });
  const internalServerUrl = endpoint.publicServerUrl
    ? endpoint.internalServerUrl
    : activeServerPort ? endpoint.internalServerUrl : null;
  const uiUrl = borrowedExpo?.running
    ? buildBorrowedExpoUiUrl({ consumerHost: host, expoPort: uiPort, serverPort: activeServerPort })
    : uiPort ? `http://${host}:${uiPort}` : null;
  const mobileUrl = mobilePort ? await preferStackLocalhostUrl(`http://localhost:${mobilePort}`, { stackName }) : null;

  const repoWorktreeSpec = repoDir ? worktreeSpecFromDir({ rootDir, component: 'happier-ui', dir: repoDir }) || null : null;
  const runtimeMode = sourceSnapshot ? 'source-snapshot' : resolveStackRuntimeMode({ argv: [], env: stackEnv }).mode;
  const runtimeInspection = sourceSnapshot ? { activeSnapshotId: null, producerStackName: null, snapshotPath: null,
    sourceFingerprint: null, valid: true, errors: [] }
    : await inspectStackRuntimeSelection({ stackName, stackBaseDir: baseDir, env: componentEnv });
  const selectedSnapshotId = runtimeInspection.activeSnapshotId;
  // The state file's snapshot identity is authoritative while a recorded lifecycle
  // process is still trusted as live. A listener is stronger evidence for endpoint
  // projection, but it is not a prerequisite for reporting the loaded runtime.
  const runtimeLifecycleLive = await hasTrustedStackRuntimeLifecycle(
    runtimeState,
    runtimeProcessTrustContext,
    runtimeStatusTrustOptions,
  );
  const loadedSnapshotId = !sourceSnapshot && runtimeLifecycleLive ? runtimeSnapshotId || null : null;
  const recordedSourceIdentities = { ...runtimeState?.sourceRuntimeIdentities };
  for (const [component, observation] of [['server', remoteServer], ['daemon', remoteDaemon]]) {
    const identity = remoteTargets[observation.target]?.sourceRuntimeIdentities?.[component];
    if (identity) recordedSourceIdentities[component] = identity;
  }
  const sourceRuntimeIdentities = sourceSnapshot ? Object.fromEntries(Object.entries(recordedSourceIdentities)
    .map(([component, identity]) => {
      const observation = component === 'daemon' ? remoteDaemon : component === 'server' ? remoteServer : remoteExpo;
      const remoteCustodyUnconfirmed = observation.target && !['stopped', 'not-running'].includes(observation.status);
      const localRunning = component === 'server' ? serverRunning : component === 'ui' ? uiRunning : daemonRunning;
      return [component, { selected: identity.selected,
        loaded: remoteCustodyUnconfirmed || (runtimeLifecycleLive && localRunning) ? identity.loaded : null }];
    })) : null;
  const pendingSourceIdentity = sourceSnapshot && Object.values(sourceRuntimeIdentities ?? {})
    .some(identity => identity.selected && identity.selected !== identity.loaded);
  if (running && pendingSourceIdentity) healthIssues.push('runtime_identity_pending');
  const sourceReload = await readJsonIfExists(join(baseDir, 'source-runtime/reload.json'));
  const sourcePreparation = sourceSnapshot ? await readPendingSourcePreparation({ stackBaseDir: baseDir }) : null;
  const preparing = Boolean(sourcePreparation) || (sourceSnapshot && sourceReload?.status === 'preparing');
  if (running && preparing) healthIssues.push('runtime_preparing');
  const healthStatus = stopCleanupIncomplete ? 'degraded' : !running
    ? remoteDaemonUnknown ? 'unknown' : sourcePreparation ? 'preparing' : 'stopped'
    : healthIssues.length > 0 ? 'degraded' : 'healthy';
  const pendingManualRestart = Boolean(
    running
    && loadedSnapshotId
    && selectedSnapshotId
    && selectedSnapshotId !== loadedSnapshotId,
  );
  const dirs = {
    repoDir,
    uiDir,
    cliDir,
    serverDir,
  };
  // These are observations of the source workspace outputs, not snapshot
  // manifests. A remote/borrowed service has a different workspace authority.
  const sourceWorkspaceStalePackages = runtimeBackedStart ? null : Object.fromEntries(await Promise.all([
    ['server', serverDir, runtimePlacement?.server],
    ['cli', cliDir, remoteDaemon.target],
    ['ui', uiDir, borrowedExpo ? 'borrowed' : remoteExpo.target],
  ].map(async ([component, dir, target]) => [component,
    target && target !== 'local' ? null : await inspectWorkspaceQaStalePackagesForComponent(dir),
  ])));

  const managedCli = remoteDaemon.target ? remoteTargets[remoteDaemon.target]?.managedCli ?? null
    : await readManagedCliIdentity(componentEnv);
  // Startup records the executing module's identity. Use that authenticated
  // daemon observation, never the wrapper's advertised source identity.
  const daemonEntry = remoteDaemon.target ? remoteTargets[remoteDaemon.target]?.daemonEntry ?? null : {
    selected: runtimeState?.sourceRuntimeLaunch?.entrypoint ?? null,
    loaded: daemonRunning ? observedDaemon.daemonState?.runtimeEntrypoint ?? null : null,
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
      managedCli,
      daemonEntry,
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
          running: daemonRunning || remoteDaemonRunning,
          pidAlive: daemonPidAlive,
          status: remoteDaemon.target ? (remoteDaemonUnknown ? 'unknown' : remoteDaemon.status) : observedDaemon.status,
          ...(remoteDaemon.target ? { lifecycleStatus: remoteDaemon.status,
            phase: remoteTargets[remoteDaemon.target]?.phase ?? null } : {}),
          source: remoteDaemon.target ? 'remote_target' : observedDaemon.source,
          remoteTarget: remoteDaemon.target,
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
          portListening: serverBackendRuntime.portListening,
          listenerPids: serverBackendRuntime.listenerPids,
          ownedListenerPids: serverBackendRuntime.ownedListenerPids,
          listenerDiscoverySupported: serverBackendRuntime.listenerDiscoverySupported,
          listenerDiscoveryStatus: serverBackendRuntime.listenerDiscoveryStatus,
          ownershipStatus: serverBackendRuntime.ownershipStatus,
        },
        ui: {
          pid: Number.isFinite(uiPid) && uiPid > 1 ? uiPid : null,
          running: uiRunning,
          pidAlive: uiPidAlive,
          portListening: uiPortListening,
          ...(borrowedUi ? { status: uiRunning ? 'running' : 'waiting for dev Expo' } : {}),
          source: borrowedUi ? 'borrowed_expo' : remoteExpo.target || (sourceUi === 'export' && remoteServer.target) ? 'remote_target' : 'local',
          ownership: borrowedUi ? 'borrowed' : 'owned',
          producerStackName: borrowedExpo?.producerStackName ?? null,
          remoteTarget: borrowedExpo?.remoteTarget ?? (sourceUi === 'export' ? remoteServer.target : remoteExpo.target),
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
      runtimePublication,
      expo: runtimeState?.expo ?? null,
      borrowedExpo,
      processes: runtimeState?.processes ?? null,
      placement: runtimePlacement,
      remoteTargets,
      stopRequest: runtimeState?.stopRequest ?? null,
      startedAt: runtimeState?.startedAt ?? null,
      updatedAt: runtimeState?.updatedAt ?? null,
      mode: runtimeMode,
      activeSnapshotId: runtimeInspection.activeSnapshotId,
      selectedSnapshotId,
      selectedProducerStackName: runtimeInspection.producerStackName,
      loadedSnapshotId,
      pendingManualRestart,
      sourceReload,
      sourcePreparation,
      snapshotPath: runtimeInspection.snapshotPath,
      sourceFingerprint: runtimeInspection.sourceFingerprint,
      buildSourceFingerprint:
        String(runtimeInspection.manifest?.source?.buildSourceFingerprint ?? '').trim() || null,
      valid: runtimeInspection.valid,
      errors: runtimeInspection.errors,
      snapshotComponents: runtimeInspection.manifest?.components ?? null,
      componentSnapshotIds: Object.fromEntries(Object.entries(runtimeInspection.componentSnapshots ?? {}).map(([component, snapshot]) => [component, snapshot.snapshotId])),
      componentTargets: runtimeInspection.componentTargets ?? null,
      sourceRuntimeIdentities,
      sourceUi,
      sourceUiLaunch,
      sourceWorkspaceStalePackages,
    },
    urls: {
      host,
      internalServerUrl,
      uiUrl,
      mobileUrl,
    },
    ports: {
      server: activeServerPort,
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
