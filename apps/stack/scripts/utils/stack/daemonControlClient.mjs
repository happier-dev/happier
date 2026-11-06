import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseDaemonLockSnapshot } from '@happier-dev/cli-common/process';

import { resolvePreferredStackDaemonStatePaths } from '../auth/credentials_paths.mjs';
import { applyStackDaemonLifecycleScopeEnv } from '../auth/stable_scope_id.mjs';
import { isRecordedStackProcessRetired, resolvePidStackOwnership } from '../proc/ownership.mjs';
import { isPidAlive, observePidLiveness } from '../proc/pids.mjs';
import { getStackRuntimeProcessInstanceFingerprint, readStackRuntimeStateFile } from './runtime_state.mjs';
import { STACK_LISTENER_OBSERVATION_TIMEOUT_MS } from '../server/listener_ownership.mjs';
import {
  processInstanceFingerprintMatches,
  readProcessInstanceFingerprintSync,
} from '@happier-dev/cli-common/processInstance';

const DEFAULT_RESTART_CONFIRM_POLL_MS = 200;
export const DEFAULT_RESTART_CONFIRM_TIMEOUT_MS = 120_000;
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

function normalizeSuccessorServerUrls(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('successor server URLs must be an object');
  }
  const serverUrl = String(value.serverUrl ?? '').trim();
  const webappUrl = String(value.webappUrl ?? '').trim();
  for (const [label, candidate] of [['server', serverUrl], ['webapp', webappUrl]]) {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(`successor ${label} URL must be a valid URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`successor ${label} URL must use http or https`);
    }
  }
  return { serverUrl, webappUrl };
}

export async function daemonControlPost({ httpPort, path, body = {}, controlToken = '', timeoutMs = DEFAULT_DAEMON_CONTROL_POST_TIMEOUT_MS }) {
  const ctl = new AbortController();
  const t = timeoutMs === null ? null : setTimeout(() => ctl.abort(), Math.max(100, timeoutMs));
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
    if (t !== null) clearTimeout(t);
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

  const stackRaw = String(env?.HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS ?? '').trim();
  if (stackRaw) {
    const parsed = Number(stackRaw);
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
  return getStackRuntimeProcessInstanceFingerprint(runtime, 'daemonPid', pid)
    ?? getStackRuntimeProcessInstanceFingerprint(runtime, 'daemonPids', pid);
}

function resolveDaemonControlStatePaths({
  cliHomeDir,
  serverUrl,
  env = process.env,
  stackName = null,
}) {
  const resolvedStackName = String(stackName ?? '').trim();
  const stateEnv = resolvedStackName
    ? applyStackDaemonLifecycleScopeEnv({
        env,
        stackName: resolvedStackName,
        cliIdentity: String(env?.HAPPIER_STACK_CLI_IDENTITY ?? '').trim() || 'default',
      })
    : env;
  return resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl, env: stateEnv });
}

export async function readDaemonControlState({
  cliHomeDir,
  serverUrl,
  env = process.env,
  stackName = null,
  resolvePidStackOwnershipImpl = resolvePidStackOwnership,
}) {
  const { statePath } = resolveDaemonControlStatePaths({ cliHomeDir, serverUrl, env, stackName });
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
  const liveness = observePidLiveness(pid);
  const retiredControl = { ok: false, reason: 'daemon_not_running', statePath, recordedStartedAt: state?.startedAt, pid };
  const retirementEvidence = {
    recordedStartedAt: state?.startedAt,
    isPidProvablyAbsentImpl: () => liveness.status === 'dead',
  };
  // Absence or a prior boot settles the record without reading runtime state
  // or asking the process now holding its old control port.
  if (isRecordedStackProcessRetired(pid, retirementEvidence)) return retiredControl;
  const ownershipContext = resolveDaemonControlOwnershipContext({ cliHomeDir, stackName, env });
  const processInstanceFingerprint = ownershipContext
    ? await readDaemonProcessInstanceFingerprint({ pid, cliHomeDir, env }) : null;
  if (processInstanceFingerprint && isRecordedStackProcessRetired(pid, {
    ...retirementEvidence,
    processInstanceFingerprint,
  })) return retiredControl;
  if (liveness.status !== 'alive') return { ok: false,
    reason: 'daemon_liveness_inconclusive', statePath, recordedStartedAt: state?.startedAt, pid };
  if (ownershipContext && typeof resolvePidStackOwnershipImpl === 'function') {
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
  timeoutMs = STACK_LISTENER_OBSERVATION_TIMEOUT_MS,
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
  successorServerUrls = null,
  readDaemonControlStateImpl = readDaemonControlState,
  daemonControlPostImpl = daemonControlPost,
  pingDaemonImpl = null,
  delayImpl = delay,
  platform = process.platform,
  readProcessInstanceFingerprintImpl = readProcessInstanceFingerprintSync,
  nowImpl = Date.now,
}) {
  const normalizedSuccessorDistClosureFingerprint = normalizeSuccessorDistClosureFingerprint(
    successorDistClosureFingerprint,
  );
  const normalizedSuccessorServerUrls = normalizeSuccessorServerUrls(successorServerUrls);
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
    // With no incumbent, the start owner uses its ordinary launch path.
    if (controlState.reason === 'missing_state' || controlState.reason === 'daemon_not_running') return null;
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
  const restartBody = {};
  if (normalizedSuccessorDistClosureFingerprint) {
    restartBody.successorDistClosureFingerprint = normalizedSuccessorDistClosureFingerprint;
  }
  if (normalizedSuccessorServerUrls) {
    restartBody.successorServerUrls = normalizedSuccessorServerUrls;
  }
  const restartResult = await daemonControlPostImpl({
    httpPort: controlState.httpPort,
    path: '/restart',
    body: restartBody,
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
  let deadline = nowImpl() + Math.max(100, confirmTimeoutMs);
  let lastReason = 'state_unchanged';
  while (true) {
    // /ping is the daemon's authenticated readiness signal. Always sample it once
    // at the deadline: a slow but healthy successor must not be reported failed
    // merely because the polling sleep crossed the boundary.
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
    } else if (replacementState.pid === previousPid) {
      lastReason = 'state_unchanged';
    } else if (
      normalizedSuccessorDistClosureFingerprint
      && String(replacementState?.distClosureFingerprint ?? '').trim()
        !== normalizedSuccessorDistClosureFingerprint
    ) {
      lastReason = 'successor_fingerprint_mismatch';
    }
    if (replacementState.ok
      && replacementState.pid !== previousPid
      && (!normalizedSuccessorDistClosureFingerprint
        || String(replacementState?.distClosureFingerprint ?? '').trim()
          === normalizedSuccessorDistClosureFingerprint)) {
      return {
        status: restartStatus,
        previousPid,
        pid: replacementState.pid,
        processInstanceFingerprint:
          replacementState.processInstanceFingerprint ?? null,
      };
    }
    if (nowImpl() >= deadline) {
      // A successor takes the daemon lock before publishing authenticated control.
      // Its live startup extends this reporting checkpoint, never readiness itself.
      let startupPid = null;
      if (['missing_state', 'pid_unchanged', 'daemon_not_running', 'ping_failed'].includes(lastReason)) {
        const { lockPath } = resolveDaemonControlStatePaths(controlStateInput);
        try {
          startupPid = parseDaemonLockSnapshot(await readFile(lockPath, 'utf8')).pid;
        } catch { }
      }
      if (!startupPid || startupPid === previousPid || !isPidAlive(startupPid)) break;
      console.warn(`[stack] replacement daemon is still starting (pid=${startupPid}); waiting for authenticated readiness`);
      deadline = nowImpl() + Math.max(100, confirmTimeoutMs);
    }
    await delayImpl(pollMs);
  }

  throw new Error(`daemon control /restart replacement was not confirmed at the ${Math.max(100, confirmTimeoutMs)}ms readiness checkpoint (${lastReason})`);
}
