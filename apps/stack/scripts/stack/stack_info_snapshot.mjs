import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { getComponentDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { getEnvValueAny } from '../utils/env/values.mjs';
import { resolveLocalhostHost, preferStackLocalhostUrl } from '../utils/paths/localhost_host.mjs';
import { worktreeSpecFromDir } from '../utils/git/worktrees.mjs';
import { getStackRuntimeStatePath, isPidAlive, readStackRuntimeStateFile } from '../utils/stack/runtime_state.mjs';
import { isTcpPortFree } from '../utils/net/ports.mjs';
import { readTextOrEmpty } from '../utils/fs/ops.mjs';
import { resolveDefaultRepoEnv } from './stack_environment.mjs';

const readExistingEnv = readTextOrEmpty;

export async function readStackInfoSnapshot({ rootDir, stackName }) {
  const baseDir = resolveStackEnvPath(stackName).baseDir;
  const envPath = resolveStackEnvPath(stackName).envPath;
  const envRaw = await readExistingEnv(envPath);
  const stackEnv = envRaw ? parseEnvToObject(envRaw) : {};
  const runtimeStatePath = getStackRuntimeStatePath(stackName);
  const runtimeState = await readStackRuntimeStateFile(runtimeStatePath);

  const serverComponent = getEnvValueAny(stackEnv, ['HAPPIER_STACK_SERVER_COMPONENT']) || 'happier-server-light';
  const stackRemote = getEnvValueAny(stackEnv, ['HAPPIER_STACK_STACK_REMOTE']) || 'upstream';

  const pinnedServerPortRaw = getEnvValueAny(stackEnv, ['HAPPIER_STACK_SERVER_PORT']);
  const pinnedServerPort = pinnedServerPortRaw ? Number(pinnedServerPortRaw) : null;

  const runtimePorts = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : {};
  const serverPort =
    Number.isFinite(pinnedServerPort) && pinnedServerPort > 0
      ? pinnedServerPort
      : Number(runtimePorts?.server) > 0
        ? Number(runtimePorts.server)
        : null;
  const backendPort = Number(runtimePorts?.backend) > 0 ? Number(runtimePorts.backend) : null;
  const uiPort =
    runtimeState?.expo && typeof runtimeState.expo === 'object' && Number(runtimeState.expo.webPort) > 0
      ? Number(runtimeState.expo.webPort)
      : null;
  const mobilePort =
    runtimeState?.expo && typeof runtimeState.expo === 'object' && Number(runtimeState.expo.mobilePort) > 0
      ? Number(runtimeState.expo.mobilePort)
      : null;
  const ownerPid = Number(runtimeState?.ownerPid);
  const serverPid = Number(runtimeState?.processes?.serverPid);
  const expoPid = Number(runtimeState?.processes?.expoPid);
  const expoTailscaleForwarderPid = Number(runtimeState?.processes?.expoTailscaleForwarderPid);

  const ownerAlive = Number.isFinite(ownerPid) && ownerPid > 1 ? isPidAlive(ownerPid) : false;
  const serverPidAlive = Number.isFinite(serverPid) && serverPid > 1 ? isPidAlive(serverPid) : false;
  const expoPidAlive = Number.isFinite(expoPid) && expoPid > 1 ? isPidAlive(expoPid) : false;
  const expoForwarderAlive =
    Number.isFinite(expoTailscaleForwarderPid) && expoTailscaleForwarderPid > 1
      ? isPidAlive(expoTailscaleForwarderPid)
      : false;

  const serverPortListening =
    Number.isFinite(serverPort) && serverPort > 0
      ? !(await isTcpPortFree(serverPort, { host: '127.0.0.1' }).catch(() => true))
      : false;
  const uiPortListening =
    Number.isFinite(uiPort) && uiPort > 0
      ? !(await isTcpPortFree(uiPort, { host: '127.0.0.1' }).catch(() => true))
      : false;

  const serverRunning =
    Number.isFinite(serverPort) && serverPort > 0
      ? serverPortListening
      : serverPidAlive;
  const uiRunning =
    Number.isFinite(uiPort) && uiPort > 0
      ? uiPortListening
      : expoPidAlive;
  const candidateRuntimePids = [ownerPid, serverPid, expoPid, expoTailscaleForwarderPid]
    .filter((pid) => Number.isFinite(pid) && pid > 1);
  const runningPid = candidateRuntimePids.find((pid) => isPidAlive(pid)) ?? null;
  const running = ownerAlive || serverRunning || uiRunning || serverPidAlive || expoPidAlive || expoForwarderAlive;

  const healthIssues = [];
  if (Number.isFinite(serverPort) && serverPort > 0 && !serverRunning) {
    healthIssues.push('server_down');
  }
  if (Number.isFinite(uiPort) && uiPort > 0 && !uiRunning) {
    healthIssues.push('ui_down');
  }
  const healthStatus = !running ? 'stopped' : healthIssues.length > 0 ? 'degraded' : 'healthy';

  const host = resolveLocalhostHost({ stackMode: true, stackName });
  const internalServerUrl = serverPort ? `http://127.0.0.1:${serverPort}` : null;
  const uiUrl = uiPort ? `http://${host}:${uiPort}` : null;
  const mobileUrl = mobilePort ? await preferStackLocalhostUrl(`http://localhost:${mobilePort}`, { stackName }) : null;

  const repoDir = getEnvValueAny(stackEnv, ['HAPPIER_STACK_REPO_DIR']) || resolveDefaultRepoEnv({ rootDir }).HAPPIER_STACK_REPO_DIR;
  const repoWorktreeSpec = repoDir ? worktreeSpecFromDir({ rootDir, component: 'happier-ui', dir: repoDir }) || null : null;
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
        server: {
          pid: Number.isFinite(serverPid) && serverPid > 1 ? serverPid : null,
          running: serverRunning,
          pidAlive: serverPidAlive,
          portListening: serverPortListening,
        },
        ui: {
          pid: Number.isFinite(expoPid) && expoPid > 1 ? expoPid : null,
          running: uiRunning,
          pidAlive: expoPidAlive,
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
      expo: runtimeState?.expo ?? null,
      processes: runtimeState?.processes ?? null,
      startedAt: runtimeState?.startedAt ?? null,
      updatedAt: runtimeState?.updatedAt ?? null,
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
