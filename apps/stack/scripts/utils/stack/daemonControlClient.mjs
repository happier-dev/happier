import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolvePreferredStackDaemonStatePaths } from '../auth/credentials_paths.mjs';
import { applyStackDaemonLifecycleScopeEnv } from '../auth/stable_scope_id.mjs';
import { resolvePidStackOwnership } from '../proc/ownership.mjs';
import { readStackRuntimeStateFile } from './runtime_state.mjs';
import {
  processInstanceFingerprintMatches,
  readProcessInstanceFingerprintSync,
} from '@happier-dev/cli-common/processInstance';

const DEFAULT_RESTART_CONFIRM_POLL_MS = 200;
const DEFAULT_RESTART_CONFIRM_TIMEOUT_MS = 60_000;
const DEFAULT_DAEMON_CONTROL_POST_TIMEOUT_MS = 10_000;

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

function normalizeSuccessorDistClosureFingerprint(value) {
  if (value === undefined || value === null) return null;
  const fingerprint = String(value).trim().toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(fingerprint)) {
    throw new Error('successor dist closure fingerprint must be exactly 16 hexadecimal characters');
  }
  return fingerprint;
}

export async function daemonControlPost({ httpPort, path, body = {}, controlToken = '', timeoutMs = DEFAULT_DAEMON_CONTROL_POST_TIMEOUT_MS }) {
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

async function readDaemonProcessInstanceFingerprint({ pid, cliHomeDir, env } = {}) {
  const envPath = String(env?.HAPPIER_STACK_ENV_FILE ?? '').trim();
  const baseDir = envPath ? dirname(envPath) : dirname(String(cliHomeDir ?? '').trim());
  if (!baseDir) return null;
  const runtime = await readStackRuntimeStateFile(join(baseDir, 'stack.runtime.json')).catch(() => null);
  for (const key of ['daemonPid', 'daemonPids']) {
    const identities = runtime?.processInstances?.processes?.[key];
    for (const identity of Array.isArray(identities) ? identities : [identities]) {
      if (Number(identity?.pid) === Number(pid)) {
        return String(identity?.fingerprint ?? '').trim() || null;
      }
    }
  }
  return null;
}

export async function readDaemonControlState({
  cliHomeDir,
  serverUrl,
  env = process.env,
  stackName = null,
  resolvePidStackOwnershipImpl = resolvePidStackOwnership,
}) {
  const resolvedStackName = String(stackName ?? '').trim();
  const stateEnv = resolvedStackName
    ? applyStackDaemonLifecycleScopeEnv({
        env,
        stackName: resolvedStackName,
        cliIdentity: String(env?.HAPPIER_STACK_CLI_IDENTITY ?? '').trim() || 'default',
      })
    : env;
  const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl, env: stateEnv });
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
    const processInstanceFingerprint = await readDaemonProcessInstanceFingerprint({
      pid,
      cliHomeDir,
      env,
    });
    if (processInstanceFingerprint) ownershipContext.processInstanceFingerprint = processInstanceFingerprint;
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

async function readDaemonControlStateForPlatform({
  input,
  platform,
  readDaemonControlStateImpl,
}) {
  let controlState = await readDaemonControlStateImpl(input);
  let windowsOwnershipBootstrap = false;
  if (
    !controlState.ok
    && platform === 'win32'
    && controlState.reason === 'daemon_not_owned'
    && controlState.ownershipReason === 'process-identity-unsupported'
  ) {
    controlState = await readDaemonControlStateImpl({
      ...input,
      resolvePidStackOwnershipImpl: null,
    });
    windowsOwnershipBootstrap = controlState.ok === true;
  }
  return { controlState, windowsOwnershipBootstrap };
}

async function proveWindowsDaemonControlState({
  controlState,
  windowsOwnershipBootstrap,
  timeoutMs,
  daemonControlPostImpl,
  readProcessInstanceFingerprintImpl,
}) {
  if (!windowsOwnershipBootstrap) {
    return { ok: true, ping: null, processInstanceFingerprint: null };
  }

  const expectedRuntimeId = String(controlState.state?.runtimeId ?? '').trim();
  const processInstanceFingerprintBefore = String(
    readProcessInstanceFingerprintImpl(controlState.pid) ?? '',
  ).trim();
  if (!expectedRuntimeId || !processInstanceFingerprintBefore) {
    return {
      ok: false,
      reason: expectedRuntimeId
        ? 'process_instance_unavailable'
        : 'daemon_runtime_identity_unavailable',
      pid: controlState.pid,
    };
  }

  let ping;
  try {
    ping = await daemonControlPostImpl({
      httpPort: controlState.httpPort,
      path: '/ping',
      controlToken: controlState.controlToken,
      timeoutMs,
    });
  } catch {
    return { ok: false, reason: 'ping_failed', pid: controlState.pid };
  }

  const processInstanceFingerprintAfter = String(
    readProcessInstanceFingerprintImpl(controlState.pid) ?? '',
  ).trim();
  if (
    !processInstanceFingerprintMatches(
      processInstanceFingerprintBefore,
      processInstanceFingerprintAfter,
    )
  ) {
    return { ok: false, reason: 'process_instance_changed', pid: controlState.pid };
  }
  if (String(ping?.runtimeId ?? '').trim() !== expectedRuntimeId) {
    return { ok: false, reason: 'daemon_runtime_identity_mismatch', pid: controlState.pid };
  }
  return {
    ok: true,
    ping,
    processInstanceFingerprint: processInstanceFingerprintBefore,
  };
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
  excludePid = null,
}, {
  platform = process.platform,
  readDaemonControlStateImpl = readDaemonControlState,
  daemonControlPostImpl = daemonControlPost,
  readProcessInstanceFingerprintImpl = readProcessInstanceFingerprintSync,
} = {}) {
  const input = {
    cliHomeDir,
    serverUrl: serverUrl ?? internalServerUrl ?? '',
    env,
    stackName,
  };
  const { controlState, windowsOwnershipBootstrap } =
    await readDaemonControlStateForPlatform({
      input,
      platform,
      readDaemonControlStateImpl,
    });
  if (!controlState.ok) return controlState;
  if (Number.isFinite(Number(excludePid)) && controlState.pid === Number(excludePid)) {
    return { ok: false, reason: 'pid_unchanged', pid: controlState.pid };
  }
  const windowsProof = await proveWindowsDaemonControlState({
    controlState,
    windowsOwnershipBootstrap,
    timeoutMs,
    daemonControlPostImpl,
    readProcessInstanceFingerprintImpl,
  });
  if (!windowsProof.ok) return windowsProof;
  try {
    const ping = windowsProof.ping ?? await daemonControlPostImpl({
        httpPort: controlState.httpPort,
        path: '/ping',
        controlToken: controlState.controlToken,
        timeoutMs,
      });
    const distClosureFingerprint = String(ping?.distClosureFingerprint ?? '').trim().toLowerCase();
    return {
      ok: true,
      pid: controlState.pid,
      state: controlState.state,
      processInstanceFingerprint: windowsProof.processInstanceFingerprint,
      distClosureFingerprint: /^[a-f0-9]{16}$/.test(distClosureFingerprint)
        ? distClosureFingerprint
        : null,
    };
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
  successorDistClosureFingerprint = null,
  readDaemonControlStateImpl = readDaemonControlState,
  daemonControlPostImpl = daemonControlPost,
  pingDaemonImpl = null,
  delayImpl = delay,
  platform = process.platform,
  readProcessInstanceFingerprintImpl = readProcessInstanceFingerprintSync,
}) {
  const normalizedSuccessorDistClosureFingerprint = normalizeSuccessorDistClosureFingerprint(
    successorDistClosureFingerprint,
  );
  const confirmTimeoutMs = resolveDaemonRestartConfirmTimeoutMs(env, timeoutMs);
  const controlPostTimeoutMs = Math.max(100, Number(requestTimeoutMs) || DEFAULT_DAEMON_CONTROL_POST_TIMEOUT_MS);
  const controlStateInput = {
    cliHomeDir,
    serverUrl: serverUrl ?? internalServerUrl ?? '',
    env,
    stackName,
  };
  const { controlState, windowsOwnershipBootstrap } =
    await readDaemonControlStateForPlatform({
      input: controlStateInput,
      platform,
      readDaemonControlStateImpl,
    });
  if (!controlState.ok) {
    throw new Error(`daemon control /restart unavailable (${controlState.reason})`);
  }
  const windowsProof = await proveWindowsDaemonControlState({
    controlState,
    windowsOwnershipBootstrap,
    timeoutMs: controlPostTimeoutMs,
    daemonControlPostImpl,
    readProcessInstanceFingerprintImpl,
  });
  if (!windowsProof.ok) {
    throw new Error(`daemon control /restart unavailable (${windowsProof.reason})`);
  }
  const restartResult = await daemonControlPostImpl({
    httpPort: controlState.httpPort,
    path: '/restart',
    body: normalizedSuccessorDistClosureFingerprint
      ? { successorDistClosureFingerprint: normalizedSuccessorDistClosureFingerprint }
      : {},
    controlToken: controlState.controlToken,
    timeoutMs: controlPostTimeoutMs,
  });
  const restartStatus = String(restartResult?.status ?? '');
  if (restartStatus !== 'restarting' && restartStatus !== 'already_restarting') {
    throw new Error('daemon control /restart returned an invalid response');
  }

  const previousPid = controlState.pid;
  const probeReplacement = typeof pingDaemonImpl === 'function'
    ? pingDaemonImpl
    : async (input) => await pingDaemon(input, {
        platform,
        readDaemonControlStateImpl,
        daemonControlPostImpl,
        readProcessInstanceFingerprintImpl,
      });
  const deadline = Date.now() + Math.max(100, confirmTimeoutMs);
  let lastReason = 'state_unchanged';
  while (Date.now() < deadline) {
    const replacementState = await probeReplacement({
      cliHomeDir,
      serverUrl: serverUrl ?? internalServerUrl ?? '',
      env,
      stackName,
      timeoutMs: controlPostTimeoutMs,
      excludePid: previousPid,
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
    if (
      normalizedSuccessorDistClosureFingerprint
      && String(replacementState?.distClosureFingerprint ?? '').trim()
        !== normalizedSuccessorDistClosureFingerprint
    ) {
      lastReason = 'successor_fingerprint_mismatch';
      await delayImpl(pollMs);
      continue;
    }
    return {
      status: restartStatus,
      previousPid,
      pid: replacementState.pid,
      processInstanceFingerprint:
        replacementState.processInstanceFingerprint ?? null,
    };
  }

  throw new Error(`daemon control /restart replacement was not confirmed within ${Math.max(100, confirmTimeoutMs)}ms (${lastReason})`);
}
