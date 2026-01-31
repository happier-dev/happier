import { join, resolve } from 'node:path';

import { ensureDepsInstalled, pmSpawnScript } from '../proc/pm.mjs';
import { applyHappyServerMigrations, ensureHappyServerManagedInfra } from '../server/infra/happy_server_infra.mjs';
import { resolveServerDevScript } from '../server/flavor_scripts.mjs';
import { waitForServerReady } from '../server/server.mjs';
import { isTcpPortFree, pickNextFreeTcpPort } from '../net/ports.mjs';
import { readStackRuntimeStateFile, recordStackRuntimeUpdate } from '../stack/runtime_state.mjs';
import { killProcessGroupOwnedByStack } from '../proc/ownership.mjs';
import { watchDebounced } from '../proc/watch.mjs';
import { pickMetroPort, resolveStablePortStart } from '../expo/metro_ports.mjs';

export function resolveStackUiDevPortStart({ env = process.env, stackName }) {
  return resolveStablePortStart({
    env: {
      ...env,
      HAPPY_STACKS_UI_DEV_PORT_BASE: (env.HAPPY_STACKS_UI_DEV_PORT_BASE ?? env.HAPPY_LOCAL_UI_DEV_PORT_BASE ?? '8081').toString(),
      HAPPY_STACKS_UI_DEV_PORT_RANGE: (env.HAPPY_STACKS_UI_DEV_PORT_RANGE ?? env.HAPPY_LOCAL_UI_DEV_PORT_RANGE ?? '1000').toString(),
    },
    stackName,
    baseKey: 'HAPPY_STACKS_UI_DEV_PORT_BASE',
    rangeKey: 'HAPPY_STACKS_UI_DEV_PORT_RANGE',
    defaultBase: 8081,
    defaultRange: 1000,
  });
}

export async function pickDevMetroPort({ startPort, reservedPorts = new Set(), host = '127.0.0.1' } = {}) {
  const forcedPort = (process.env.HAPPY_STACKS_UI_DEV_PORT ?? process.env.HAPPY_LOCAL_UI_DEV_PORT ?? '').toString().trim();
  return await pickMetroPort({ startPort, forcedPort, reservedPorts, host });
}

export async function startDevServer({
  serverComponentName,
  serverDir,
  autostart,
  baseEnv,
  serverPort,
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
}) {
  const serverEnv = {
    ...baseEnv,
    PORT: String(serverPort),
    PUBLIC_URL: publicServerUrl,
    // Avoid noisy failures if a previous run left the metrics port busy.
    METRICS_ENABLED: baseEnv.METRICS_ENABLED ?? 'false',
  };

  if (serverComponentName === 'happy-server-light') {
    const dataDir = baseEnv.HAPPY_SERVER_LIGHT_DATA_DIR?.trim()
      ? baseEnv.HAPPY_SERVER_LIGHT_DATA_DIR.trim()
      : join(autostart.baseDir, 'server-light');
    serverEnv.HAPPY_SERVER_LIGHT_DATA_DIR = dataDir;
    serverEnv.HAPPY_SERVER_LIGHT_FILES_DIR = baseEnv.HAPPY_SERVER_LIGHT_FILES_DIR?.trim()
      ? baseEnv.HAPPY_SERVER_LIGHT_FILES_DIR.trim()
      : join(dataDir, 'files');
    serverEnv.DATABASE_URL = baseEnv.DATABASE_URL?.trim() ? baseEnv.DATABASE_URL.trim() : `file:${join(dataDir, 'happy-server-light.sqlite')}`;
  }

  if (serverComponentName === 'happy-server') {
    const managed = (baseEnv.HAPPY_STACKS_MANAGED_INFRA ?? baseEnv.HAPPY_LOCAL_MANAGED_INFRA ?? '1') !== '0';
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

    const autoMigrate = (baseEnv.HAPPY_STACKS_PRISMA_MIGRATE ?? baseEnv.HAPPY_LOCAL_PRISMA_MIGRATE ?? '1') !== '0';
    if (autoMigrate) {
      await applyHappyServerMigrations({ serverDir, env: serverEnv });
    }
  }

  // Ensure server deps exist before any Prisma/docker work.
  await ensureDepsInstalled(serverDir, serverComponentName, { quiet, env: serverEnv });

  const prismaPush = (baseEnv.HAPPY_STACKS_PRISMA_PUSH ?? baseEnv.HAPPY_LOCAL_PRISMA_PUSH ?? '1').toString().trim() !== '0';
  const serverScript = resolveServerDevScript({ serverComponentName, serverDir, prismaPush });

  // Restart behavior (stack-safe): only kill when we can prove ownership via runtime state.
  if (restart && stackMode && runtimeStatePath && serverAlreadyRunning) {
    const st = await readStackRuntimeStateFile(runtimeStatePath);
    const pid = Number(st?.processes?.serverPid);
    if (pid > 1) {
      const res = await killProcessGroupOwnedByStack(pid, { stackName: autostart.stackName, envPath, label: 'server', json: true });
      if (!res.killed) {
        // Fail-closed if the port is still occupied.
        const free = await isTcpPortFree(serverPort, { host: '127.0.0.1' });
        if (!free) {
          throw new Error(
            `[local] restart refused: server port ${serverPort} is occupied and the PID is not provably stack-owned.\n` +
              `[local] Fix: run 'happys stack stop ${autostart.stackName}' then re-run, or re-run without --restart.`
          );
        }
      }
    }
  }

  if (serverAlreadyRunning && !restart) {
    return { serverEnv, serverScript, serverProc: null };
  }

  const server = await pmSpawnScript({
    label: 'server',
    dir: serverDir,
    script: serverScript,
    env: serverEnv,
    options: spawnOptions,
    quiet,
  });
  children.push(server);
  if (stackMode && runtimeStatePath) {
    await recordStackRuntimeUpdate(runtimeStatePath, { processes: { serverPid: server.pid } }).catch(() => {});
  }
  await waitForServerReady(internalServerUrl);
  return { serverEnv, serverScript, serverProc: server };
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
}) {
  if (!enabled) return null;

  // Only watch full server by default; happy-server-light already has a good upstream dev loop.
  if (serverComponentName !== 'happy-server') return null;

  return watchDebounced({
    paths: [resolve(serverDir)],
    debounceMs: 600,
    onChange: async () => {
      if (isShuttingDown?.()) return;
      const pid = Number(serverProcRef?.current?.pid);
      if (!Number.isFinite(pid) || pid <= 1) return;

      try {
        // eslint-disable-next-line no-console
        console.log('[local] watch: server changed → restarting...');
        await killProcessGroupOwnedByStack(pid, { stackName, envPath, label: 'server', json: false });

        const next = await pmSpawnScript({ label: 'server', dir: serverDir, script: serverScript, env: serverEnv });
        children.push(next);
        serverProcRef.current = next;
        if (stackMode && runtimeStatePath) {
          await recordStackRuntimeUpdate(runtimeStatePath, { processes: { serverPid: next.pid } }).catch(() => {});
        }
        await waitForServerReady(internalServerUrl);
        // eslint-disable-next-line no-console
        console.log(`[local] watch: server restarted (pid=${next.pid}, port=${serverPort})`);
      } catch (e) {
        const msg = e instanceof Error ? e.stack || e.message : String(e);
        // eslint-disable-next-line no-console
        console.error('[local] watch: server restart failed; keeping existing process as-is (will retry on next change).');
        // eslint-disable-next-line no-console
        console.error(msg);
      }
    },
  });
}
