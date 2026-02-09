import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { getComponentDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { getEnvValueAny } from '../utils/env/values.mjs';
import { resolveLocalhostHost, preferStackLocalhostUrl } from '../utils/paths/localhost_host.mjs';
import { worktreeSpecFromDir } from '../utils/git/worktrees.mjs';
import { getStackRuntimeStatePath, isPidAlive, readStackRuntimeStateFile } from '../utils/stack/runtime_state.mjs';
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

  const ownerPid = Number(runtimeState?.ownerPid);
  const running = isPidAlive(ownerPid);
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
      running,
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
