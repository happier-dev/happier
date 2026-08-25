import { freemem, loadavg, platform } from 'node:os';
import { readFile, stat } from 'node:fs/promises';

import { runCaptureResult } from '../utils/proc/proc.mjs';

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseProcessRows(output) {
  return String(output ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [pid, ppid, rssKiB, cpuPercent, threadCount] = line.split(/\s+/);
    return {
      pid: numberOrNull(pid),
      ppid: numberOrNull(ppid),
      rssBytes: numberOrNull(rssKiB) == null ? null : Number(rssKiB) * 1024,
      cpuPercent: numberOrNull(cpuPercent),
      threadCount: numberOrNull(threadCount),
    };
  }).filter((row) => row.pid != null && row.ppid != null);
}

function selectProcessTree(rows, rootPid) {
  const selected = new Map();
  const pending = [Number(rootPid)];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (!Number.isFinite(pid) || selected.has(pid)) continue;
    const row = rows.find((candidate) => candidate.pid === pid);
    if (row) selected.set(pid, row);
    for (const candidate of rows) {
      if (candidate.ppid === pid && !selected.has(candidate.pid)) pending.push(candidate.pid);
    }
  }
  return [...selected.values()];
}

async function collectProcessTreePids(rootPid, { env }) {
  const selected = new Set([Number(rootPid)]);
  const pending = [Number(rootPid)];
  while (pending.length > 0 && selected.size < 512) {
    const parentPid = pending.shift();
    const result = await runCaptureResult('pgrep', ['-P', String(parentPid)], {
      env,
      timeoutMs: 1_000,
    }).catch(() => ({ exitCode: 1, out: '' }));
    if (result.exitCode !== 0 && result.exitCode !== 1) break;
    for (const line of String(result.out ?? '').split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (!Number.isFinite(pid) || selected.has(pid)) continue;
      selected.add(pid);
      pending.push(pid);
    }
  }
  return [...selected];
}

async function collectProcessMetrics(rootPid, { env }) {
  if (!Number.isFinite(Number(rootPid))) return null;
  const threadColumn = platform() === 'linux' ? ',nlwp=' : '';
  const pids = await collectProcessTreePids(rootPid, { env });
  const processSelector = pids.join(',');
  let result = await runCaptureResult('ps', ['-o', `pid=,ppid=,rss=,%cpu=${threadColumn}`, '-p', processSelector], {
    env,
    timeoutMs: 5_000,
  });
  if (result.exitCode !== 0) {
    result = await runCaptureResult('ps', ['-o', 'pid=,ppid=,rss=,%cpu=', '-p', processSelector], {
      env,
      timeoutMs: 5_000,
    });
  }
  if (result.exitCode !== 0) return null;
  const tree = selectProcessTree(parseProcessRows(result.out), rootPid);
  if (tree.length === 0) return null;
  return {
    rssBytes: tree.reduce((sum, row) => sum + (row.rssBytes ?? 0), 0),
    cpuPercent: tree.reduce((sum, row) => sum + (row.cpuPercent ?? 0), 0),
    processCount: tree.length,
    threadCount: tree.some((row) => row.threadCount != null)
      ? tree.reduce((sum, row) => sum + (row.threadCount ?? 0), 0)
      : null,
  };
}

function parseMeminfo(text) {
  const values = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([^:]+):\s+(\d+)\s+kB$/i.exec(line.trim());
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  return values;
}

function parsePsi(text) {
  const result = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const [kind, ...fields] = line.trim().split(/\s+/);
    if (!kind) continue;
    result[kind] = Object.fromEntries(fields.map((field) => field.split('=')).map(([key, value]) => [key, Number(value)]));
  }
  return result;
}

async function collectLinuxHostMetrics() {
  const [meminfoText, cpuPsi, memoryPsi, ioPsi] = await Promise.all([
    readFile('/proc/meminfo', 'utf8'),
    readFile('/proc/pressure/cpu', 'utf8').catch(() => ''),
    readFile('/proc/pressure/memory', 'utf8').catch(() => ''),
    readFile('/proc/pressure/io', 'utf8').catch(() => ''),
  ]);
  const meminfo = parseMeminfo(meminfoText);
  return {
    loadAverage1m: loadavg()[0] ?? null,
    availableMemoryBytes: meminfo.get('MemAvailable') ?? freemem(),
    swapUsedBytes: Math.max(0, (meminfo.get('SwapTotal') ?? 0) - (meminfo.get('SwapFree') ?? 0)),
    psi: {
      cpu: parsePsi(cpuPsi),
      memory: parsePsi(memoryPsi),
      io: parsePsi(ioPsi),
    },
  };
}

function parseScaledBytes(value, unit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scale = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[String(unit).toUpperCase()] ?? 1;
  return Math.round(number * scale);
}

async function collectDarwinHostMetrics({ env }) {
  const swap = await runCaptureResult('sysctl', ['-n', 'vm.swapusage'], {
    env,
    timeoutMs: 5_000,
  }).catch(() => ({ code: 1, out: '' }));
  const match = /used\s*=\s*([0-9.]+)([KMGT]?)/i.exec(swap.out);
  return {
    loadAverage1m: loadavg()[0] ?? null,
    availableMemoryBytes: freemem(),
    swapUsedBytes: match ? parseScaledBytes(match[1], match[2]) : null,
  };
}

async function measureLatency(operation) {
  const startedAt = process.hrtime.bigint();
  try {
    await operation();
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  } catch {
    return null;
  }
}

async function collectResponsivenessMetrics({ cwd, env }) {
  const trueCommand = platform() === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', 'exit 0']]
    : ['/usr/bin/true', []];
  const [shellSpawnLatencyMs, filesystemLatencyMs] = await Promise.all([
    measureLatency(async () => {
      const result = await runCaptureResult(trueCommand[0], trueCommand[1], { env, timeoutMs: 5_000 });
      if (result.exitCode !== 0) throw new Error('responsiveness command failed');
    }),
    measureLatency(() => stat(cwd)),
  ]);
  return { shellSpawnLatencyMs, filesystemLatencyMs };
}

export async function collectSystemMetrics({ rootPid, cwd = process.cwd(), env = process.env } = {}) {
  const [processMetrics, hostMetrics, responsiveness] = await Promise.all([
    collectProcessMetrics(Number(rootPid), { env }).catch(() => null),
    platform() === 'linux'
      ? collectLinuxHostMetrics().catch(() => ({ loadAverage1m: loadavg()[0] ?? null, availableMemoryBytes: freemem(), swapUsedBytes: null }))
      : collectDarwinHostMetrics({ env }),
    collectResponsivenessMetrics({ cwd, env }),
  ]);
  return { process: processMetrics, host: { ...hostMetrics, responsiveness } };
}
