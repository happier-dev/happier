import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getComponentDir } from '../paths/paths.mjs';
import { isPidAlive, readPidState } from '../expo/expo.mjs';
import { stopLocalDaemon } from '../../daemon.mjs';
import { stopHappyServerManagedInfra } from '../server/infra/happy_server_infra.mjs';
import { deleteStackRuntimeStateFile, getStackRuntimeStatePath, readStackRuntimeStateFile } from './runtime_state.mjs';
import { killPidOwnedByStack, killProcessGroupOwnedByStack, listPidsWithEnvNeedle } from '../proc/ownership.mjs';
import { coercePort } from '../server/port.mjs';

function resolveServerComponentFromStackEnv(env) {
  const v =
    (env.HAPPIER_STACK_SERVER_COMPONENT ?? '').toString().trim() || 'happier-server-light';
  return v === 'happier-server' ? 'happier-server' : 'happier-server-light';
}

async function daemonControlPost({ httpPort, path, body = {} }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${httpPort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`daemon control ${path} failed (http ${res.status}): ${text.trim()}`);
    }
    return text.trim() ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

async function stopDaemonTrackedSessions({ cliHomeDir, json }) {
  // Read daemon state file written by happier-cli; needed to call control server (/list, /stop-session).
  const statePath = join(cliHomeDir, 'daemon.state.json');
  if (!existsSync(statePath)) {
    return { ok: true, skipped: true, reason: 'missing_state', stoppedSessionIds: [] };
  }

  let state = null;
  try {
    state = JSON.parse(await readFile(statePath, 'utf-8'));
  } catch {
    return { ok: false, skipped: true, reason: 'bad_state', stoppedSessionIds: [] };
  }

  const httpPort = Number(state?.httpPort);
  const pid = Number(state?.pid);
  if (!Number.isFinite(httpPort) || httpPort <= 0) {
    return { ok: false, skipped: true, reason: 'missing_http_port', stoppedSessionIds: [] };
  }
  if (!Number.isFinite(pid) || pid <= 1) {
    return { ok: false, skipped: true, reason: 'missing_pid', stoppedSessionIds: [] };
  }
  try {
    process.kill(pid, 0);
  } catch {
    return { ok: true, skipped: true, reason: 'daemon_not_running', stoppedSessionIds: [] };
  }

  const listed = await daemonControlPost({ httpPort, path: '/list' }).catch((e) => {
    if (!json) console.warn(`[stack] failed to list daemon sessions: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  const children = Array.isArray(listed?.children) ? listed.children : [];

  const stoppedSessionIds = [];
  for (const child of children) {
    const sid = String(child?.happySessionId ?? '').trim();
    if (!sid) continue;
    // eslint-disable-next-line no-await-in-loop
    const res = await daemonControlPost({ httpPort, path: '/stop-session', body: { sessionId: sid } }).catch(() => null);
    if (res?.success) {
      stoppedSessionIds.push(sid);
    }
  }

  return { ok: true, skipped: false, stoppedSessionIds };
}

async function stopExpoStateDir({ stackName, baseDir, kind, stateFileName, envPath, json }) {
  const root = join(baseDir, kind);
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const killed = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const statePath = join(root, e.name, stateFileName);
    // eslint-disable-next-line no-await-in-loop
    const state = await readPidState(statePath);
    if (!state) continue;
    const pid = Number(state.pid);

    if (!Number.isFinite(pid) || pid <= 1) continue;
    if (!isPidAlive(pid)) continue;

    if (!json) {
      // eslint-disable-next-line no-console
      console.log(`[stack] stopping ${kind} (pid=${pid}) for ${stackName}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await killProcessGroupOwnedByStack(pid, { stackName, envPath, label: kind, json });
    killed.push({ pid, port: null, statePath });
  }
  return killed;
}

export async function stopStackWithEnv({ rootDir, stackName, baseDir, env, json, noDocker = false, aggressive = false, sweepOwned = false }) {
  const actions = {
    stackName,
    baseDir,
    aggressive,
    sweepOwned,
    runner: null,
    daemonSessionsStopped: null,
    daemonStopped: false,
    killedPorts: [],
    expoDev: [],
    uiDev: [],
    mobile: [],
    infra: null,
    errors: [],
  };

  const serverComponent = resolveServerComponentFromStackEnv(env);
  const port = coercePort(env.HAPPIER_STACK_SERVER_PORT);
  const backendPort = coercePort(env.HAPPIER_STACK_SERVER_BACKEND_PORT);
  const cliHomeDir = (env.HAPPIER_STACK_CLI_HOME_DIR ?? join(baseDir, 'cli')).toString();
  const cliDir = getComponentDir(rootDir, 'happier-cli', env);
  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const envPath = (env.HAPPIER_STACK_ENV_FILE ?? '').toString();

  // Preferred: stop stack-started processes (by PID) recorded in stack.runtime.json.
  // This is safer than killing whatever happens to listen on a port, and doesn't rely on the runner's shutdown handler.
  const runtimeStatePath = getStackRuntimeStatePath(stackName);
  const runtimeState = await readStackRuntimeStateFile(runtimeStatePath);
  const runnerPid = Number(runtimeState?.ownerPid);
  const processes = runtimeState?.processes && typeof runtimeState.processes === 'object' ? runtimeState.processes : {};

  // Kill known child processes first (process groups), then stop daemon, then stop runner.
  const killedProcessPids = [];
  for (const [key, rawPid] of Object.entries(processes)) {
    const pid = Number(rawPid);
    if (!Number.isFinite(pid) || pid <= 1) continue;
    if (!isPidAlive(pid)) continue;
    // eslint-disable-next-line no-await-in-loop
    const res = await killProcessGroupOwnedByStack(pid, { stackName, envPath, cliHomeDir, label: key, json });
    if (res.killed) {
      killedProcessPids.push({ key, pid, reason: res.reason, pgid: res.pgid ?? null });
    }
  }
  actions.runner = { stopped: false, pid: Number.isFinite(runnerPid) ? runnerPid : null, reason: runtimeState ? 'not_running_or_not_owned' : 'missing_state' };
  actions.killedPorts = actions.killedPorts ?? [];
  actions.processes = { killed: killedProcessPids };

  if (aggressive) {
    try {
      actions.daemonSessionsStopped = await stopDaemonTrackedSessions({ cliHomeDir, json });
    } catch (e) {
      actions.errors.push({ step: 'daemon-sessions', error: e instanceof Error ? e.message : String(e) });
    }
  }

  try {
    const internalServerUrl = port ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:3005';
    await stopLocalDaemon({ cliBin, internalServerUrl, cliHomeDir });
    actions.daemonStopped = true;
  } catch (e) {
    actions.errors.push({ step: 'daemon', error: e instanceof Error ? e.message : String(e) });
  }

  // Now stop the runner PID last (if it exists). This should clean up any remaining state files it owns.
  if (Number.isFinite(runnerPid) && runnerPid > 1 && isPidAlive(runnerPid)) {
    if (!json) {
      // eslint-disable-next-line no-console
      console.log(`[stack] stopping runner (pid=${runnerPid}) for ${stackName}`);
    }
    const res = await killPidOwnedByStack(runnerPid, { stackName, envPath, cliHomeDir, label: 'runner', json });
    actions.runner = { stopped: res.killed, pid: runnerPid, reason: res.reason };
  }

  // Only delete runtime state if the runner is confirmed stopped (or not running).
  if (!isPidAlive(runnerPid)) {
    await deleteStackRuntimeStateFile(runtimeStatePath);
  }

  try {
    actions.expoDev = await stopExpoStateDir({ stackName, baseDir, kind: 'expo-dev', stateFileName: 'expo.state.json', envPath, json });
  } catch (e) {
    actions.errors.push({ step: 'expo-dev', error: e instanceof Error ? e.message : String(e) });
  }
  try {
    // Legacy cleanups (best-effort): older runs used separate state dirs.
    actions.uiDev = await stopExpoStateDir({ stackName, baseDir, kind: 'ui-dev', stateFileName: 'ui.state.json', envPath, json });
    const killedDev = await stopExpoStateDir({ stackName, baseDir, kind: 'mobile-dev', stateFileName: 'mobile.state.json', envPath, json });
    const killedLegacy = await stopExpoStateDir({ stackName, baseDir, kind: 'mobile', stateFileName: 'expo.state.json', envPath, json });
    actions.mobile = [...killedDev, ...killedLegacy];
  } catch (e) {
    actions.errors.push({ step: 'expo-mobile', error: e instanceof Error ? e.message : String(e) });
  }

  // IMPORTANT:
  // Never kill "whatever is listening on a port" in stack mode.
  void backendPort;
  void port;

  const managed = (env.HAPPIER_STACK_MANAGED_INFRA ?? '1').toString().trim() !== '0';
  if (!noDocker && serverComponent === 'happier-server' && managed) {
    try {
      actions.infra = await stopHappyServerManagedInfra({ stackName, baseDir, removeVolumes: false });
    } catch (e) {
      actions.errors.push({ step: 'infra', error: e instanceof Error ? e.message : String(e) });
    }
  } else {
    actions.infra = { ok: true, skipped: true, reason: noDocker ? 'no_docker' : 'not_managed_or_not_happier_server' };
  }

  // Last resort: sweep any remaining processes that still carry this stack env file in their environment.
  // This is still safe because envPath is unique per stack; we also exclude our own PID.
  if (sweepOwned && envPath) {
    const needle1 = `HAPPIER_STACK_ENV_FILE=${envPath}`;
    const pids = [...(await listPidsWithEnvNeedle(needle1))]
      .filter((pid) => pid !== process.pid)
      .filter((pid) => Number.isFinite(pid) && pid > 1);

    const swept = [];
    for (const pid of Array.from(new Set(pids))) {
      if (!isPidAlive(pid)) continue;
      // eslint-disable-next-line no-await-in-loop
      const res = await killProcessGroupOwnedByStack(pid, { stackName, envPath, cliHomeDir, label: 'sweep', json });
      if (res.killed) {
        swept.push({ pid, reason: res.reason, pgid: res.pgid ?? null });
      }
    }
    actions.sweep = { pids: swept };
  }

  return actions;
}
