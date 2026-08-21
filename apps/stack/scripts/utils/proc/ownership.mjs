import { runCapture } from './proc.mjs';
import { observePidLiveness } from './pids.mjs';
import { terminateProcessGroup, terminateProcessPid } from './terminate.mjs';
import { readdir, readFile } from 'node:fs/promises';
import {
  processInstanceFingerprintMatches,
  readProcessInstanceFingerprintSync,
} from '@happier-dev/cli-common/processInstance';

function normalizeNeedles(needles) {
  const raw = Array.isArray(needles) ? needles : [];
  return raw.map((n) => String(n ?? '').trim()).filter(Boolean);
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseEnvBindingNeedle(needle) {
  const raw = String(needle ?? '').trim();
  const match = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
  if (!match) return null;
  return { name: match[1], value: match[2] };
}

const ENV_BINDING_BOUNDARY = String.raw`[\s\x00]`;

export function textContainsNeedle(text, needle) {
  const haystack = String(text ?? '');
  const rawNeedle = String(needle ?? '').trim();
  if (!rawNeedle) return false;
  const binding = parseEnvBindingNeedle(rawNeedle);
  if (!binding) return haystack.includes(rawNeedle);
  const pattern = new RegExp(`(?:^|${ENV_BINDING_BOUNDARY})${escapeRegExp(binding.name)}=${escapeRegExp(binding.value)}(?:${ENV_BINDING_BOUNDARY}|$)`);
  return pattern.test(haystack);
}

export function textContainsEnvBindingName(text, name) {
  const haystack = String(text ?? '');
  const envName = String(name ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) return false;
  return new RegExp(`(?:^|${ENV_BINDING_BOUNDARY})${escapeRegExp(envName)}=`).test(haystack);
}

function textContainsAllNeedles(text, needles) {
  return needles.every((needle) => textContainsNeedle(text, needle));
}

function textContainsAllEnvBindingNames(text, names) {
  return names.every((name) => textContainsEnvBindingName(text, name));
}

async function readLinuxProcEnviron(pid, { signal } = {}) {
  try {
    const raw = await readFile(`/proc/${pid}/environ`, { encoding: 'utf-8', signal });
    return String(raw ?? '').replaceAll('\0', ' ').trim();
  } catch {
    return '';
  }
}

async function readLinuxProcCmdline(pid, { signal } = {}) {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, { encoding: 'utf-8', signal });
    return String(raw ?? '').replaceAll('\0', ' ').trim();
  } catch {
    return '';
  }
}

async function listLinuxProcPidsWithEnvNeedles(needles) {
  if (process.platform !== 'linux') return null;
  const ns = normalizeNeedles(needles);
  if (ns.length === 0) return [];
  try {
    const entries = await readdir('/proc', { withFileTypes: true });
    const pids = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (!Number.isFinite(pid) || pid <= 1) continue;
      // eslint-disable-next-line no-await-in-loop
      const envText = await readLinuxProcEnviron(pid);
      if (!envText) continue;
      if (textContainsAllNeedles(envText, ns)) {
        pids.push(pid);
      }
    }
    return Array.from(new Set(pids));
  } catch {
    return null;
  }
}

async function listLinuxProcPidsWithEnvNeedlesAndEnvBindingNames(needles, bindingNames) {
  if (process.platform !== 'linux') return null;
  const ns = normalizeNeedles(needles);
  const names = normalizeNeedles(bindingNames);
  if (ns.length === 0 && names.length === 0) return [];
  try {
    const entries = await readdir('/proc', { withFileTypes: true });
    const pids = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (!Number.isFinite(pid) || pid <= 1) continue;
      // eslint-disable-next-line no-await-in-loop
      const envText = await readLinuxProcEnviron(pid);
      if (!envText) continue;
      if (textContainsAllNeedles(envText, ns) && textContainsAllEnvBindingNames(envText, names)) {
        pids.push(pid);
      }
    }
    return Array.from(new Set(pids));
  } catch {
    return null;
  }
}

export function parsePsPidCommandOutputForNeedles(output, needles) {
  const ns = normalizeNeedles(needles);
  if (ns.length === 0) return [];

  const text = String(output ?? '');
  const pids = [];
  for (const line of text.split('\n')) {
    if (!textContainsAllNeedles(line, ns)) continue;
    const m = line.trim().match(/^(\d+)\s+/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (Number.isFinite(pid) && pid > 1) {
      pids.push(pid);
    }
  }
  return Array.from(new Set(pids));
}

export function parsePsPidCommandOutputForNeedlesAndEnvBindingNames(output, needles, bindingNames) {
  const ns = normalizeNeedles(needles);
  const names = normalizeNeedles(bindingNames);
  if (ns.length === 0 && names.length === 0) return [];

  const text = String(output ?? '');
  const pids = [];
  for (const line of text.split('\n')) {
    if (!textContainsAllNeedles(line, ns)) continue;
    if (!textContainsAllEnvBindingNames(line, names)) continue;
    const m = line.trim().match(/^(\d+)\s+/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (Number.isFinite(pid) && pid > 1) {
      pids.push(pid);
    }
  }
  return Array.from(new Set(pids));
}

export async function listPsPidsForEnvQueries(
  queries,
  {
    platform = process.platform,
    runCaptureImpl = runCapture,
    timeoutMs,
    signal,
  } = {},
) {
  const normalizedQueries = (Array.isArray(queries) ? queries : []).map((query) => ({
    needles: normalizeNeedles(query?.needles),
    bindingNames: normalizeNeedles(query?.bindingNames),
  }));
  if (normalizedQueries.length === 0) return [];
  if (platform === 'win32') return normalizedQueries.map(() => []);
  if (platform === 'linux') {
    const results = [];
    for (const query of normalizedQueries) {
      // Linux reads /proc directly and does not incur the system-wide macOS ps snapshot cost.
      // eslint-disable-next-line no-await-in-loop
      const pids = query.bindingNames.length > 0
        ? await listLinuxProcPidsWithEnvNeedlesAndEnvBindingNames(query.needles, query.bindingNames)
        : await listLinuxProcPidsWithEnvNeedles(query.needles);
      results.push(Array.isArray(pids) ? pids : []);
    }
    return results;
  }

  // macOS process/environment enumeration is expensive under load. Capture it exactly once and
  // answer every ownership query from the same snapshot rather than serially running full scans.
  const output = await runCaptureImpl('ps', ['eww', '-ax', '-o', 'pid=,command='], { timeoutMs, signal });
  return normalizedQueries.map((query) => query.bindingNames.length > 0
    ? parsePsPidCommandOutputForNeedlesAndEnvBindingNames(output, query.needles, query.bindingNames)
    : parsePsPidCommandOutputForNeedles(output, query.needles));
}

export async function observePsEnvLine(
  pid,
  {
    platform = process.platform,
    runCaptureImpl = runCapture,
    readLinuxProcEnvironImpl = readLinuxProcEnviron,
    readLinuxProcCmdlineImpl = readLinuxProcCmdline,
    observePidLivenessImpl = observePidLiveness,
    timeoutMs,
    signal,
  } = {},
) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return { status: 'not_found', line: null, reason: 'invalid_pid' };
  if (signal?.aborted) return { status: 'inconclusive', line: null, reason: 'process-identity-timeout' };
  if (platform === 'win32') {
    return { status: 'inconclusive', line: null, reason: 'process-identity-unsupported' };
  }
  if (platform === 'linux') {
    const envText = await readLinuxProcEnvironImpl(n, { signal });
    if (signal?.aborted) return { status: 'inconclusive', line: null, reason: 'process-identity-timeout' };
    if (envText) {
      const cmdline = await readLinuxProcCmdlineImpl(n, { signal });
      if (signal?.aborted) return { status: 'inconclusive', line: null, reason: 'process-identity-timeout' };
      return { status: 'ok', line: `${n} ${cmdline} ${envText}`.trim(), reason: 'proc_environ' };
    }
  }
  try {
    const out = await runCaptureImpl('ps', ['eww', '-p', String(n)], { timeoutMs, signal });
    // Output usually includes a header line and then a single process line.
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2) return { status: 'ok', line: lines[1], reason: 'ps' };
    if (lines.length === 1) return { status: 'ok', line: lines[0], reason: 'ps' };
    return { status: 'not_found', line: null, reason: 'process-not-found' };
  } catch (error) {
    if (error?.code === 'ETIMEDOUT' || error?.code === 'ABORT_ERR' || signal?.aborted) {
      return { status: 'inconclusive', line: null, reason: 'process-identity-timeout', error };
    }
    try {
      const liveness = observePidLivenessImpl(n);
      if (liveness?.status === 'dead') {
        return { status: 'not_found', line: null, reason: 'process-not-found' };
      }
    } catch {
      // Failed liveness evidence remains inconclusive.
    }
    return { status: 'inconclusive', line: null, reason: 'process-identity-unavailable', error };
  }
}

export async function getPsEnvLine(pid) {
  const observation = await observePsEnvLine(pid);
  return observation.status === 'ok' ? observation.line : null;
}

export async function getPidStartTime(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return null;
  if (process.platform === 'win32') return null;
  try {
    const out = await runCapture('ps', ['-o', 'lstart=', '-p', String(n)]);
    const v = String(out ?? '').trim();
    return v || null;
  } catch {
    return null;
  }
}

export async function listPidsWithEnvNeedle(needle) {
  const n = String(needle ?? '').trim();
  if (!n) return [];
  if (process.platform === 'win32') return [];
  const viaProc = await listLinuxProcPidsWithEnvNeedles([n]);
  if (Array.isArray(viaProc)) return viaProc;
  try {
    // Include environment variables (eww) so we can match on HAPPIER_STACK_ENV_FILE=/.../env safely.
    const out = await runCapture('ps', ['eww', '-ax', '-o', 'pid=,command=']);
    return parsePsPidCommandOutputForNeedles(out, [n]);
  } catch {
    return [];
  }
}

export async function listPidsWithEnvNeedles(needles) {
  const ns = normalizeNeedles(needles);
  if (ns.length === 0) return [];
  if (process.platform === 'win32') return [];
  const viaProc = await listLinuxProcPidsWithEnvNeedles(ns);
  if (Array.isArray(viaProc)) return viaProc;
  try {
    // Include environment variables (eww) so we can match on HAPPIER_STACK_ENV_FILE=/.../env safely.
    const out = await runCapture('ps', ['eww', '-ax', '-o', 'pid=,command=']);
    return parsePsPidCommandOutputForNeedles(out, ns);
  } catch {
    return [];
  }
}

export async function listPidsWithEnvNeedlesAndEnvBindingNames(needles, bindingNames) {
  const ns = normalizeNeedles(needles);
  const names = normalizeNeedles(bindingNames);
  if (ns.length === 0 && names.length === 0) return [];
  if (process.platform === 'win32') return [];
  const viaProc = await listLinuxProcPidsWithEnvNeedlesAndEnvBindingNames(ns, names);
  if (Array.isArray(viaProc)) return viaProc;
  try {
    // Include environment variables (eww) so we can match on exact env bindings safely.
    const out = await runCapture('ps', ['eww', '-ax', '-o', 'pid=,command=']);
    return parsePsPidCommandOutputForNeedlesAndEnvBindingNames(out, ns, names);
  } catch {
    return [];
  }
}

export async function getProcessGroupId(pid, { timeoutMs, signal } = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return null;
  if (process.platform === 'win32') return null;
  try {
    const out = await runCapture('ps', ['-o', 'pgid=', '-p', String(n)], { timeoutMs, signal });
    const raw = out.trim();
    const pgid = raw ? Number(raw) : NaN;
    return Number.isFinite(pgid) && pgid > 1 ? pgid : null;
  } catch {
    return null;
  }
}

export function readStackProcessKindFromEnvLine(line) {
  const match = String(line ?? '').match(/(?:^|[\s\x00])HAPPIER_STACK_PROCESS_KIND=([^\s\x00]+)/);
  return match ? String(match[1] ?? '').trim() : '';
}

export async function resolvePidStackOwnership(
  pid,
  { stackName, envPath, cliHomeDir, processInstanceFingerprint } = {},
  {
    platform = process.platform,
    observePsEnvLineImpl = observePsEnvLine,
    observePidLivenessImpl = observePidLiveness,
    readProcessInstanceFingerprintImpl = readProcessInstanceFingerprintSync,
    timeoutMs,
    signal,
  } = {},
) {
  const expectedFingerprint = String(processInstanceFingerprint ?? '').trim();
  if (expectedFingerprint) {
    const observedFingerprint = readProcessInstanceFingerprintImpl(pid);
    if (!processInstanceFingerprintMatches(expectedFingerprint, observedFingerprint)) {
      return {
        status: observedFingerprint ? 'not_owned' : 'inconclusive',
        owned: observedFingerprint ? false : null,
        reason: observedFingerprint ? 'process_instance_mismatch' : 'process_instance_unavailable',
      };
    }
    if (platform === 'win32') {
      return { status: 'owned', owned: true, reason: 'process_instance' };
    }
  }
  const observation = await observePsEnvLineImpl(pid, { observePidLivenessImpl, timeoutMs, signal });
  if (observation?.status === 'inconclusive') {
    return { status: 'inconclusive', owned: null, reason: observation.reason, observation };
  }
  const line = observation?.status === 'ok' ? observation.line : null;
  if (!line) return { status: 'not_owned', owned: false, reason: observation?.reason ?? 'missing_process_env' };

  // Daemon-spawned interactive sessions intentionally inherit the stack env file
  // so in-session stack commands target the right stack. They are not stack infra,
  // and stack stop/restart must never use that env inheritance as kill ownership.
  if (readStackProcessKindFromEnvLine(line) === 'session') {
    return { status: 'not_owned', owned: false, reason: 'session_process_kind' };
  }

  const sn = String(stackName ?? '').trim();
  const ep = String(envPath ?? '').trim();
  const ch = String(cliHomeDir ?? '').trim();

  // Require at least one stack identifier.
  const hasStack =
    (sn && textContainsNeedle(line, `HAPPIER_STACK_STACK=${sn}`)) ||
    (!sn && textContainsEnvBindingName(line, 'HAPPIER_STACK_STACK'));
  if (!hasStack) return { status: 'not_owned', owned: false, reason: 'stack_name_mismatch' };

  // Prefer env-file binding (strongest).
  if (ep) {
    if (textContainsNeedle(line, `HAPPIER_STACK_ENV_FILE=${ep}`)) {
      return { status: 'owned', owned: true, reason: 'env_file' };
    }
  }

  // Fallback: CLI home dir binding (useful for daemon-related processes).
  if (ch) {
    if (textContainsNeedle(line, `HAPPIER_HOME_DIR=${ch}`) || textContainsNeedle(line, `HAPPIER_STACK_CLI_HOME_DIR=${ch}`)) {
      return { status: 'owned', owned: true, reason: 'cli_home' };
    }
  }

  return { status: 'not_owned', owned: false, reason: 'not_owned' };
}

export async function isPidOwnedByStack(pid, { stackName, envPath, cliHomeDir } = {}) {
  const ownership = await resolvePidStackOwnership(pid, { stackName, envPath, cliHomeDir });
  if (ownership.status === 'inconclusive') {
    const error = new Error(`process identity observation is inconclusive: ${ownership.reason}`);
    error.code = 'EPROCESSIDENTITYINCONCLUSIVE';
    error.observation = ownership.observation ?? ownership;
    throw error;
  }
  return ownership.owned;
}

function resolveAlreadyExitedCleanup(ownership) {
  return ownership?.reason === 'process-not-found'
    ? { killed: true, reason: 'already_exited' }
    : null;
}

function resolveExactProcessInstanceFingerprint(
  pid,
  processInstanceFingerprint,
  readProcessInstanceFingerprintImpl,
  platform,
) {
  const suppliedFingerprint = String(processInstanceFingerprint ?? '').trim();
  if (suppliedFingerprint) return suppliedFingerprint;
  // A fresh Windows CIM identity can pin the current process, but without a
  // persisted expected identity Windows has no environment-proof path that
  // establishes that the current process belongs to this stack.
  if (platform === 'win32') return null;
  try {
    return String(readProcessInstanceFingerprintImpl(pid) ?? '').trim() || null;
  } catch {
    return null;
  }
}

function resolveUnavailableProcessInstanceCleanup(pid, observePidLivenessImpl) {
  let liveness;
  try {
    liveness = observePidLivenessImpl(pid);
  } catch {
    liveness = null;
  }
  return liveness?.status === 'dead'
    ? { killed: true, reason: 'already_exited' }
    : { killed: false, reason: 'process_instance_unavailable' };
}

export async function killPidOwnedByStack(pid, {
  stackName,
  envPath,
  cliHomeDir,
  processInstanceFingerprint,
  label = 'process',
  json = false,
  graceMs = 800,
  signal = 'SIGTERM',
  resolvePidStackOwnershipImpl = resolvePidStackOwnership,
  terminateProcessPidImpl = terminateProcessPid,
  readProcessInstanceFingerprintImpl = readProcessInstanceFingerprintSync,
  observePidLivenessImpl = observePidLiveness,
  platform = process.platform,
} = {}) {
  const exactProcessInstanceFingerprint = resolveExactProcessInstanceFingerprint(
    pid,
    processInstanceFingerprint,
    readProcessInstanceFingerprintImpl,
    platform,
  );
  if (!exactProcessInstanceFingerprint) {
    return resolveUnavailableProcessInstanceCleanup(pid, observePidLivenessImpl);
  }
  const ownership = await resolvePidStackOwnershipImpl(pid, {
    stackName,
    envPath,
    cliHomeDir,
    processInstanceFingerprint: exactProcessInstanceFingerprint,
  });
  if (!ownership.owned) {
    const alreadyExited = resolveAlreadyExitedCleanup(ownership);
    if (alreadyExited) return alreadyExited;
    if (!json) {
      // eslint-disable-next-line no-console
      console.warn(`[stack] refusing to kill ${label} pid=${pid} (cannot prove it belongs to stack ${stackName ?? ''})`);
    }
    return { killed: false, reason: ownership.reason };
  }
  const terminated = await terminateProcessPidImpl(pid, {
    graceMs,
    signal,
    processInstanceFingerprint: exactProcessInstanceFingerprint,
  });
  return terminated.ok
    ? { killed: true, reason: terminated.alreadyExited ? 'already_exited' : 'killed', signal: terminated.signal }
    : { killed: false, reason: terminated.reason ?? 'kill_timeout', signal: terminated.signal };
}

export async function killProcessGroupOwnedByStack(
  pid,
  {
    stackName,
    envPath,
    cliHomeDir,
    processInstanceFingerprint,
    label = 'process-group',
    json = false,
    signal = 'SIGTERM',
    graceMs = 800,
    platform = process.platform,
    resolvePidStackOwnershipImpl = resolvePidStackOwnership,
    getProcessGroupIdImpl = getProcessGroupId,
    terminateProcessPidImpl = terminateProcessPid,
    terminateProcessGroupImpl = terminateProcessGroup,
    readProcessInstanceFingerprintImpl = readProcessInstanceFingerprintSync,
    observePidLivenessImpl = observePidLiveness,
  } = {}
) {
  const exactProcessInstanceFingerprint = resolveExactProcessInstanceFingerprint(
    pid,
    processInstanceFingerprint,
    readProcessInstanceFingerprintImpl,
    platform,
  );
  if (!exactProcessInstanceFingerprint) {
    return resolveUnavailableProcessInstanceCleanup(pid, observePidLivenessImpl);
  }
  const ownership = await resolvePidStackOwnershipImpl(pid, {
    stackName,
    envPath,
    cliHomeDir,
    processInstanceFingerprint: exactProcessInstanceFingerprint,
  });
  if (!ownership.owned) {
    const alreadyExited = resolveAlreadyExitedCleanup(ownership);
    if (alreadyExited) return alreadyExited;
    if (!json) {
      // eslint-disable-next-line no-console
      console.warn(`[stack] refusing to kill ${label} pid=${pid} (cannot prove it belongs to stack ${stackName ?? ''})`);
    }
    return { killed: false, reason: ownership.reason };
  }
  if (platform === 'win32') {
    const terminated = await terminateProcessGroupImpl(pid, {
      graceMs,
      signal,
      identityPid: pid,
      processInstanceFingerprint: exactProcessInstanceFingerprint,
    });
    if (!terminated.ok) {
      return { killed: false, reason: terminated.reason ?? 'kill_timeout', signal: terminated.signal ?? 'SIGKILL' };
    }
    return { killed: true, reason: 'killed_tree', signal: terminated.signal ?? 'SIGKILL' };
  }
  const pgid = await getProcessGroupIdImpl(pid);
  if (!pgid) {
    const terminated = await terminateProcessPidImpl(pid, {
      graceMs,
      signal,
      processInstanceFingerprint: exactProcessInstanceFingerprint,
    });
    return terminated.ok
      ? { killed: true, reason: terminated.alreadyExited ? 'already_exited' : 'killed_pid_only', signal: terminated.signal }
      : { killed: false, reason: terminated.reason ?? 'kill_timeout', signal: terminated.signal };
  }
  const selfPgid = await getProcessGroupIdImpl(process.pid);
  // Safety: never signal our own process group from stack stop helpers.
  // If target PGID matches ours, kill only the target PID to avoid self-termination.
  if (selfPgid && selfPgid === pgid) {
    const terminated = await terminateProcessPidImpl(pid, {
      graceMs,
      signal,
      processInstanceFingerprint: exactProcessInstanceFingerprint,
    });
    return terminated.ok
      ? { killed: true, reason: terminated.alreadyExited ? 'already_exited' : 'killed_pid_only', pgid, signal: terminated.signal }
      : { killed: false, reason: terminated.reason ?? 'kill_timeout', pgid, signal: terminated.signal };
  }
  const terminated = await terminateProcessGroupImpl(pgid, {
    graceMs,
    signal,
    identityPid: pid,
    processInstanceFingerprint: exactProcessInstanceFingerprint,
  });
  if (!terminated.ok) {
    return { killed: false, reason: terminated.reason ?? 'kill_timeout', pgid, signal: terminated.signal ?? 'SIGKILL' };
  }
  return { killed: true, reason: 'killed_pgid', pgid, signal: terminated.signal ?? 'SIGKILL' };
}
