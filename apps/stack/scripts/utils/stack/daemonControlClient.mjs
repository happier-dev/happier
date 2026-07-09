import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { resolvePreferredStackDaemonStatePaths } from '../auth/credentials_paths.mjs';
import { resolvePidStackOwnership } from '../proc/ownership.mjs';

const DEFAULT_RESTART_CONFIRM_POLL_MS = 200;
const DEFAULT_RESTART_CONFIRM_TIMEOUT_MS = 60_000;
const DEFAULT_DAEMON_CONTROL_POST_TIMEOUT_MS = 1500;

export class DaemonControlPostError extends Error {
  constructor({ path, status, responseText }) {
    super(`daemon control ${path} failed (http ${status}): ${String(responseText ?? '').trim()}`);
    this.name = 'DaemonControlPostError';
    this.daemonControlPath = path;
    this.status = status;
    this.responseText = responseText;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export async function daemonControlPost({ httpPort, path, body = {}, controlToken = '', timeoutMs = 1500 }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.max(100, timeoutMs));
  try {
    const headers = { 'content-type': 'application/json' };
    const token = String(controlToken ?? '').trim();
    if (token) headers['x-happier-daemon-token'] = token;
    const res = await fetch(`http://127.0.0.1:${httpPort}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new DaemonControlPostError({ path, status: res.status, responseText: text });
    }
    return text.trim() ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

export function resolveDaemonRestartConfirmTimeoutMs(env = process.env, explicitTimeoutMs = null) {
  const explicit = Number(explicitTimeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit);

  const raw = String(env?.HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS ?? '').trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }

  return DEFAULT_RESTART_CONFIRM_TIMEOUT_MS;
}

function resolveDaemonControlOwnershipContext({ cliHomeDir, stackName, env } = {}) {
  const resolvedStackName = String(stackName ?? '').trim();
  if (!resolvedStackName) return null;
  return {
    stackName: resolvedStackName,
    envPath: String(env?.HAPPIER_STACK_ENV_FILE ?? '').trim(),
    cliHomeDir: String(cliHomeDir ?? env?.HAPPIER_STACK_CLI_HOME_DIR ?? env?.HAPPIER_HOME_DIR ?? '').trim(),
  };
}

export async function readDaemonControlState({
  cliHomeDir,
  serverUrl,
  env = process.env,
  stackName = null,
  resolvePidStackOwnershipImpl = resolvePidStackOwnership,
}) {
  const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl, env });
  if (!existsSync(statePath)) {
    return { ok: false, reason: 'missing_state', statePath };
  }

  let state = null;
  try {
    state = JSON.parse(await readFile(statePath, 'utf-8'));
  } catch {
    return { ok: false, reason: 'bad_state', statePath };
  }

  const httpPort = Number(state?.httpPort);
  const pid = Number(state?.pid);
  const controlToken = String(state?.controlToken ?? '').trim();
  if (!Number.isFinite(httpPort) || httpPort <= 0) {
    return { ok: false, reason: 'missing_http_port', statePath };
  }
  if (!Number.isFinite(pid) || pid <= 1) {
    return { ok: false, reason: 'missing_pid', statePath };
  }
  try {
    process.kill(pid, 0);
  } catch {
    return { ok: false, reason: 'daemon_not_running', statePath, pid };
  }
  const ownershipContext = resolveDaemonControlOwnershipContext({ cliHomeDir, stackName, env });
  if (ownershipContext && typeof resolvePidStackOwnershipImpl === 'function') {
    const ownership = await resolvePidStackOwnershipImpl(pid, ownershipContext);
    if (ownership?.owned !== true) {
      return {
        ok: false,
        reason: 'daemon_not_owned',
        statePath,
        pid,
        ownershipReason: ownership?.reason ?? 'not_owned',
      };
    }
  }
  return { ok: true, statePath, state, pid, httpPort, controlToken };
}

export function isDaemonControlRestartUnavailableError(error) {
  const path = String(error?.daemonControlPath ?? error?.path ?? '').trim();
  if (path && path !== '/restart') return false;
  const status = Number(error?.status ?? error?.statusCode);
  if (status === 404 || status === 501) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /daemon control \/restart failed/.test(message)
    && (/\b404\b/.test(message) || /\b501\b/.test(message) || /restart_unavailable/.test(message));
}

export async function pingDaemon({
  cliHomeDir,
  serverUrl,
  internalServerUrl,
  env = process.env,
  stackName = null,
  timeoutMs = 1500,
}) {
  const controlState = await readDaemonControlState({
    cliHomeDir,
    serverUrl: serverUrl ?? internalServerUrl ?? '',
    env,
    stackName,
  });
  if (!controlState.ok) return controlState;
  try {
    await daemonControlPost({
      httpPort: controlState.httpPort,
      path: '/ping',
      controlToken: controlState.controlToken,
      timeoutMs,
    });
    return { ok: true, pid: controlState.pid, state: controlState.state };
  } catch {
    return { ok: false, reason: 'ping_failed', pid: controlState.pid };
  }
}

export async function restartDaemonViaControlServer({
  cliHomeDir,
  internalServerUrl,
  serverUrl,
  env = process.env,
  stackName = null,
  timeoutMs = null,
  requestTimeoutMs = DEFAULT_DAEMON_CONTROL_POST_TIMEOUT_MS,
  pollMs = DEFAULT_RESTART_CONFIRM_POLL_MS,
  readDaemonControlStateImpl = readDaemonControlState,
  daemonControlPostImpl = daemonControlPost,
  delayImpl = delay,
}) {
  const confirmTimeoutMs = resolveDaemonRestartConfirmTimeoutMs(env, timeoutMs);
  const controlPostTimeoutMs = Math.max(100, Number(requestTimeoutMs) || DEFAULT_DAEMON_CONTROL_POST_TIMEOUT_MS);
  const controlState = await readDaemonControlStateImpl({
    cliHomeDir,
    serverUrl: serverUrl ?? internalServerUrl ?? '',
    env,
    stackName,
  });
  if (!controlState.ok) {
    throw new Error(`daemon control /restart unavailable (${controlState.reason})`);
  }
  const restartResult = await daemonControlPostImpl({
    httpPort: controlState.httpPort,
    path: '/restart',
    body: {},
    controlToken: controlState.controlToken,
    timeoutMs: controlPostTimeoutMs,
  });
  const restartStatus = String(restartResult?.status ?? '');
  if (restartStatus !== 'restarting' && restartStatus !== 'already_restarting') {
    throw new Error('daemon control /restart returned an invalid response');
  }

  const previousPid = controlState.pid;
  const deadline = Date.now() + Math.max(100, confirmTimeoutMs);
  let lastReason = 'state_unchanged';
  while (Date.now() < deadline) {
    const replacementState = await readDaemonControlStateImpl({
      cliHomeDir,
      serverUrl: serverUrl ?? internalServerUrl ?? '',
      env,
      stackName,
    });
    if (!replacementState.ok) {
      lastReason = replacementState.reason ?? 'state_unavailable';
      await delayImpl(pollMs);
      continue;
    }
    if (replacementState.pid === previousPid) {
      lastReason = 'state_unchanged';
      await delayImpl(pollMs);
      continue;
    }
    try {
      await daemonControlPostImpl({
        httpPort: replacementState.httpPort,
        path: '/ping',
        controlToken: replacementState.controlToken,
        timeoutMs: Math.min(Math.max(100, controlPostTimeoutMs), DEFAULT_DAEMON_CONTROL_POST_TIMEOUT_MS),
      });
      return {
        status: restartStatus,
        previousPid,
        pid: replacementState.pid,
      };
    } catch {
      lastReason = 'replacement_ping_failed';
      await delayImpl(pollMs);
    }
  }

  throw new Error(`daemon control /restart replacement was not confirmed within ${Math.max(100, confirmTimeoutMs)}ms (${lastReason})`);
}
