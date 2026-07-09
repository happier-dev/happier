import { runCapture } from './proc.mjs';
import { killPid } from '../expo/expo.mjs';
import { terminateProcessGroup } from './terminate.mjs';
import { readdir, readFile } from 'node:fs/promises';

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

function textContainsEnvBindingName(text, name) {
  const haystack = String(text ?? '');
  const envName = String(name ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) return false;
  return new RegExp(`(?:^|${ENV_BINDING_BOUNDARY})${escapeRegExp(envName)}=`).test(haystack);
}

export function readStackProcessKindFromEnvLine(line) {
  const match = String(line ?? '').match(/(?:^|[\s\x00])HAPPIER_STACK_PROCESS_KIND=([^\s\x00]+)/);
  return match ? String(match[1] ?? '').trim() : '';
}

function textContainsAllNeedles(text, needles) {
  return needles.every((needle) => textContainsNeedle(text, needle));
}

function textContainsAllEnvBindingNames(text, names) {
  return names.every((name) => textContainsEnvBindingName(text, name));
}

async function readLinuxProcEnviron(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/environ`, 'utf-8');
    return String(raw ?? '').replaceAll('\0', ' ').trim();
  } catch {
    return '';
  }
}

async function readLinuxProcCmdline(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf-8');
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

export async function getPsEnvLine(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return null;
  if (process.platform === 'win32') return null;
  if (process.platform === 'linux') {
    const envText = await readLinuxProcEnviron(n);
    if (envText) {
      const cmdline = await readLinuxProcCmdline(n);
      return `${n} ${cmdline} ${envText}`.trim();
    }
  }
  try {
    const out = await runCapture('ps', ['eww', '-p', String(n)]);
    // Output usually includes a header line and then a single process line.
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2) return lines[1];
    if (lines.length === 1) return lines[0];
    return null;
  } catch {
    return null;
  }
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

export async function getProcessGroupId(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return null;
  if (process.platform === 'win32') return null;
  try {
    const out = await runCapture('ps', ['-o', 'pgid=', '-p', String(n)]);
    const raw = out.trim();
    const pgid = raw ? Number(raw) : NaN;
    return Number.isFinite(pgid) && pgid > 1 ? pgid : null;
  } catch {
    return null;
  }
}

export async function resolvePidStackOwnership(pid, { stackName, envPath, cliHomeDir } = {}) {
  const line = await getPsEnvLine(pid);
  if (!line) return { owned: false, reason: 'missing_process_env' };

  // Daemon-spawned interactive sessions intentionally inherit stack env so
  // in-session stack commands target the right stack. They are not stack infra,
  // and stack stop/restart must never treat that inheritance as kill ownership.
  if (readStackProcessKindFromEnvLine(line) === 'session') {
    return { owned: false, reason: 'session_process_kind' };
  }

  const sn = String(stackName ?? '').trim();
  const ep = String(envPath ?? '').trim();
  const ch = String(cliHomeDir ?? '').trim();

  // Require at least one stack identifier.
  const hasStack =
    (sn && textContainsNeedle(line, `HAPPIER_STACK_STACK=${sn}`)) ||
    (!sn && textContainsEnvBindingName(line, 'HAPPIER_STACK_STACK'));
  if (!hasStack) return { owned: false, reason: 'stack_name_mismatch' };

  // Prefer env-file binding (strongest).
  if (ep) {
    if (textContainsNeedle(line, `HAPPIER_STACK_ENV_FILE=${ep}`)) {
      return { owned: true, reason: 'env_file' };
    }
  }

  // Fallback: CLI home dir binding (useful for daemon-related processes).
  if (ch) {
    if (textContainsNeedle(line, `HAPPIER_HOME_DIR=${ch}`) || textContainsNeedle(line, `HAPPIER_STACK_CLI_HOME_DIR=${ch}`)) {
      return { owned: true, reason: 'cli_home' };
    }
  }

  return { owned: false, reason: 'not_owned' };
}

export async function isPidOwnedByStack(pid, { stackName, envPath, cliHomeDir } = {}) {
  const ownership = await resolvePidStackOwnership(pid, { stackName, envPath, cliHomeDir });
  return ownership.owned;
}

export async function killPidOwnedByStack(pid, { stackName, envPath, cliHomeDir, label = 'process', json = false } = {}) {
  const ownership = await resolvePidStackOwnership(pid, { stackName, envPath, cliHomeDir });
  if (!ownership.owned) {
    if (!json) {
      // eslint-disable-next-line no-console
      console.warn(`[stack] refusing to kill ${label} pid=${pid} (cannot prove it belongs to stack ${stackName ?? ''})`);
    }
    return { killed: false, reason: ownership.reason };
  }
  await killPid(pid);
  return { killed: true, reason: 'killed' };
}

export async function killProcessGroupOwnedByStack(
  pid,
  { stackName, envPath, cliHomeDir, label = 'process-group', json = false, signal = 'SIGTERM', graceMs = 800 } = {}
) {
  const ownership = await resolvePidStackOwnership(pid, { stackName, envPath, cliHomeDir });
  if (!ownership.owned) {
    if (!json) {
      // eslint-disable-next-line no-console
      console.warn(`[stack] refusing to kill ${label} pid=${pid} (cannot prove it belongs to stack ${stackName ?? ''})`);
    }
    return { killed: false, reason: ownership.reason };
  }
  const pgid = await getProcessGroupId(pid);
  if (!pgid) {
    await killPid(pid);
    return { killed: true, reason: 'killed_pid_only' };
  }
  const selfPgid = await getProcessGroupId(process.pid);
  // Safety: never signal our own process group from stack stop helpers.
  // If target PGID matches ours, kill only the target PID to avoid self-termination.
  if (selfPgid && selfPgid === pgid) {
    await killPid(pid);
    return { killed: true, reason: 'killed_pid_only', pgid };
  }
  const terminated = await terminateProcessGroup(pgid, { graceMs, signal });
  if (!terminated.ok) {
    return { killed: false, reason: 'kill_timeout', pgid, signal: terminated.signal ?? 'SIGKILL' };
  }
  return { killed: true, reason: 'killed_pgid', pgid, signal: terminated.signal ?? 'SIGKILL' };
}
