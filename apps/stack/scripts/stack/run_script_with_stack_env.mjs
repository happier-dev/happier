import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { buildConfigureServerLinks } from '@happier-dev/cli-common/links';

import { findExistingStackCredentialPath } from '../utils/auth/credentials_paths.mjs';
import { ensureDir } from '../utils/fs/ops.mjs';
import { readLastLines } from '../utils/fs/tail.mjs';
import { isTcpPortFree, listListenPids, pickNextFreeTcpPort } from '../utils/net/ports.mjs';
import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { resolveLocalhostHost } from '../utils/paths/localhost_host.mjs';
import { killProcessGroupOwnedByStack } from '../utils/proc/ownership.mjs';
import { run } from '../utils/proc/proc.mjs';
import { coercePort } from '../utils/server/port.mjs';
import { waitForHttpOk } from '../utils/server/server.mjs';
import { getCliHomeDirFromEnvOrDefault } from '../utils/stack/dirs.mjs';
import {
  deleteStackRuntimeStateFile,
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

export function hasRecordedRuntimePortsForRestart(runtimeState = null) {
  const ports = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : null;
  return Number(ports?.server) > 0;
}

export function shouldReuseRuntimePortsOnRestart({ wantsRestart = false, runtimeState = null, wasRunning = false } = {}) {
  return Boolean(wantsRestart && (wasRunning || hasRecordedRuntimePortsForRestart(runtimeState)));
}

export async function runStackScriptWithStackEnv({ rootDir, stackName, scriptPath, args, extraEnv = {}, background = false }) {
  await withStackEnv({
    stackName,
    extraEnv,
    fn: async ({ env, envPath, stackEnv, runtimeStatePath, runtimeState }) => {
      const isStartLike = scriptPath === 'dev.mjs' || scriptPath === 'run.mjs';
      if (!isStartLike) {
        await run(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], { cwd: rootDir, env });
        return;
      }

      const wantsRestart = args.includes('--restart');
      const wantsJson = args.includes('--json');
      const pinnedServerPort = Boolean((stackEnv.HAPPIER_STACK_SERVER_PORT ?? '').trim());
      const serverComponent = (stackEnv.HAPPIER_STACK_SERVER_COMPONENT ?? '').toString().trim() || 'happier-server-light';
      const managedInfra =
        serverComponent === 'happier-server'
          ? (stackEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1').toString().trim() !== '0'
          : false;

      // If this is an ephemeral-port stack and it's already running, avoid spawning a second copy.
      const existingOwnerPid = Number(runtimeState?.ownerPid);
      const existingPort = Number(runtimeState?.ports?.server);
      const existingUiPort = Number(runtimeState?.expo?.webPort);
      const existingPorts = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : null;
      const infraRuntimePids = [
        Number(runtimeState?.processes?.serverPid),
        Number(runtimeState?.processes?.expoPid),
        Number(runtimeState?.processes?.expoTailscaleForwarderPid),
      ].filter((pid) => Number.isFinite(pid) && pid > 1);
      const infraPidAlive = infraRuntimePids.some((pid) => isPidAlive(pid));
      const serverPortOccupied =
        Number.isFinite(existingPort) && existingPort > 0
          ? !(await isTcpPortFree(existingPort, { host: '127.0.0.1' }).catch(() => true))
          : false;
      const wasRunning = isPidAlive(existingOwnerPid) || infraPidAlive || serverPortOccupied;
      // True restart = there was an active runner for this stack. If the stack is not running,
      // `--restart` should behave like a normal start (allocate new ephemeral ports if needed).
      const isTrueRestart = shouldReuseRuntimePortsOnRestart({ wantsRestart, runtimeState, wasRunning });

      // Restart semantics (stack mode):
      // - Stop stack-owned processes first (runner, daemon, Expo, etc.)
      // - Never kill arbitrary port listeners
      // - Preserve previous runtime ports in memory so a true restart can reuse them
      if (wantsRestart && !wantsJson) {
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
          });
        } catch {
          // ignore (fail-closed below on port checks)
        }
        await deleteStackRuntimeStateFile(runtimeStatePath).catch(() => {});
      }
      if (wasRunning) {
        if (!wantsRestart) {
          const serverPart = Number.isFinite(existingPort) && existingPort > 0 ? ` server=${existingPort}` : '';
          const uiPart =
            scriptPath === 'dev.mjs' && Number.isFinite(existingUiPort) && existingUiPort > 0 ? ` ui=${existingUiPort}` : '';
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
          const wantsMobile = args.includes('--mobile') || args.includes('--with-mobile');
          if (wantsMobile) {
            await run(process.execPath, [join(rootDir, 'scripts', 'mobile.mjs'), '--metro'], { cwd: rootDir, env });
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
        const candidatePorts =
          isTrueRestart && existingPorts
            ? {
                server: parsePortOrNull(existingPorts.server),
                backend: parsePortOrNull(existingPorts.backend),
                pg: parsePortOrNull(existingPorts.pg),
                redis: parsePortOrNull(existingPorts.redis),
                minio: parsePortOrNull(existingPorts.minio),
                minioConsole: parsePortOrNull(existingPorts.minioConsole),
              }
            : null;

        const canReuse =
          candidatePorts &&
          candidatePorts.server &&
          (serverComponent !== 'happier-server' || candidatePorts.backend) &&
          (!managedInfra || (candidatePorts.pg && candidatePorts.redis && candidatePorts.minio && candidatePorts.minioConsole));

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
        if (!(await isTcpPortFree(Number(ports.server)))) {
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
            await deleteStackRuntimeStateFile(runtimeStatePath).catch(() => {});
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
          await deleteStackRuntimeStateFile(runtimeStatePath).catch(() => {});
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
    },
  });
}
