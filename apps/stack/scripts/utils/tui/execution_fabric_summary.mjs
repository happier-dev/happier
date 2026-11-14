import { open, readFile, readdir } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { EXECUTION_PROVENANCE_FILENAME, readExecutionDurationSummaries } from '../dev_targets/execution_provenance.mjs';

const HISTORY_WINDOW_MS = 60 * 60 * 1000;
// Read granularity for the backward scan, not a retention limit.
const TAIL_CHUNK_BYTES = 1024 * 1024;

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function numberAt(values, index) {
  const value = Number(values[index]);
  return Number.isFinite(value) ? value : null;
}

function parseTelemetry(raw) {
  const values = String(raw ?? '').trim().split(/\s+/);
  if (values.length < 16) return null;
  return {
    capacity: numberAt(values, 0),
    load: numberAt(values, 1),
    freeRatio: numberAt(values, 2),
    diskFreeKiB: numberAt(values, 3),
    diskUsedPercent: numberAt(values, 4),
    runQueue: numberAt(values, 5),
    memAvailableKiB: numberAt(values, 6),
    memTotalKiB: numberAt(values, 7),
    swapUsedKiB: numberAt(values, 8),
    swapTotalKiB: numberAt(values, 9),
    cpuPsiAvg10: numberAt(values, 10),
    memoryPsiAvg10: numberAt(values, 11),
    ioPsiAvg10: numberAt(values, 12),
    swapInPages: numberAt(values, 13),
    swapOutPages: numberAt(values, 14),
    platform: ['linux', 'darwin'].includes(values[15]) ? values[15] : 'unknown',
  };
}

function parseCacheAge(raw, now) {
  const sampledAtSeconds = Number(String(raw ?? '').trim().split(/\s+/)[0]);
  if (!Number.isFinite(sampledAtSeconds) || sampledAtSeconds <= 0) return null;
  return Math.max(0, Math.floor((now - sampledAtSeconds * 1000) / 1000));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readActiveReservations(cacheDir, targetName) {
  let names = [];
  try {
    names = await readdir(cacheDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const prefix = `${targetName}.active.`;
  let active = 0;
  const classes = new Map();
  await Promise.all(names.filter((name) => name.startsWith(prefix)).map(async (name) => {
    const [pidRaw, commandClass = 'unknown'] = (await readText(join(cacheDir, name))).split(/\r?\n/);
    const pid = Number(pidRaw);
    if (!Number.isInteger(pid) || pid <= 0 || !processIsAlive(pid)) return;
    active += 1;
    classes.set(commandClass || 'unknown', (classes.get(commandClass || 'unknown') ?? 0) + 1);
  }));
  return { active, classes: Object.fromEntries(classes) };
}

async function readTargetSnapshot(cacheDir, targetName, now) {
  const [telemetryRaw, cacheRaw, reservations] = await Promise.all([
    readText(join(cacheDir, `${targetName}.telemetry`)),
    readText(join(cacheDir, `${targetName}.cache`)),
    readActiveReservations(cacheDir, targetName),
  ]);
  const telemetry = parseTelemetry(telemetryRaw);
  return {
    name: targetName,
    ...(telemetry ?? {}),
    activeReservations: reservations.active,
    activeClasses: reservations.classes,
    cacheAgeSeconds: parseCacheAge(cacheRaw, now),
    available: telemetry != null,
  };
}

function parseAdmission(line) {
  if (!line.trim()) return null;
  try {
    const record = JSON.parse(line);
    return Number.isFinite(record?.timestamp) ? record : null;
  } catch {
    return null;
  }
}

/** The append-only audit log is unbounded, so the "last 60m" pane keeps a
 * retained byte offset: the first read scans backward from EOF only until a
 * record older than the window, later reads parse only appended bytes. A
 * shrunk or replaced file restarts the scan. */
function createRecentAdmissionsWindow(path) {
  let identity = null;
  let offset = 0;
  let admissions = [];

  const keep = (record) => record.schemaVersion === 1 && record.phase === 'admitted' && record.target;

  async function scanBackward(handle, size, cutoff) {
    let position = size;
    let buffer = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(TAIL_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      buffer = Buffer.concat([chunk.subarray(0, bytesRead), buffer]);
      // The oldest complete line read so far decides whether the window is covered.
      const start = position > 0 ? buffer.indexOf(10) + 1 : 0;
      const end = start > 0 || position === 0 ? buffer.indexOf(10, start) : -1;
      const head = start > 0 || position === 0 ? parseAdmission(buffer.subarray(start, end === -1 ? buffer.length : end).toString('utf8')) : null;
      if (head && head.timestamp < cutoff) break;
    }
    // The first partial line belongs to an older record outside the window.
    return position > 0 ? buffer.subarray(buffer.indexOf(10) + 1) : buffer;
  }

  return {
    async read(now) {
      const cutoff = now - HISTORY_WINDOW_MS;
      let handle;
      try {
        handle = await open(path, 'r');
      } catch (error) {
        if (error?.code === 'ENOENT') { identity = null; offset = 0; admissions = []; return admissions; }
        throw error;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return admissions = [];
        const current = `${stat.dev}:${stat.ino}`;
        let bytes;
        if (current !== identity || stat.size < offset) {
          identity = current;
          admissions = [];
          bytes = await scanBackward(handle, stat.size, cutoff);
          offset = stat.size - bytes.length;
        } else {
          const length = stat.size - offset;
          bytes = Buffer.alloc(length);
          const { bytesRead } = length > 0 ? await handle.read(bytes, 0, length, offset) : { bytesRead: 0 };
          bytes = bytes.subarray(0, bytesRead);
        }
        // Retain an incomplete final line for the next read.
        const complete = bytes.lastIndexOf(10) + 1;
        offset += complete;
        for (const line of bytes.subarray(0, complete).toString('utf8').split('\n')) {
          const record = parseAdmission(line);
          if (record && keep(record)) admissions.push(record);
        }
        admissions = admissions.filter((record) => record.timestamp >= cutoff);
        return admissions;
      } finally {
        await handle.close();
      }
    },
  };
}

function summarizeByTarget(records) {
  const grouped = new Map();
  for (const record of records) {
    const target = String(record.target);
    grouped.set(target, (grouped.get(target) ?? 0) + 1);
  }
  return [...grouped].map(([target, count]) => ({ target, count, share: count / records.length }));
}

function defaultLocalSample() {
  return {
    name: 'primary',
    platform: process.platform === 'darwin' ? 'darwin' : 'linux',
    capacity: cpus().length,
    load: loadavg()[0],
    memAvailableKiB: Math.floor(freemem() / 1024),
    memTotalKiB: Math.floor(totalmem() / 1024),
  };
}

/** Live load comes from per-target cache files, run time from the compact
 * per-class duration projection, and recent dispatches from a bounded tail of
 * the append-only audit log (811 MB on repo-dev, 2026-11-14), never a whole-file read. */
export function createExecutionFabricSummaryReader({
  stackBaseDir,
  targetNames,
  sampleLocal = defaultLocalSample,
  readDurations = readExecutionDurationSummaries,
}) {
  const cacheDir = join(stackBaseDir, 'dev-target-command-load-native');
  const recentAdmissions = createRecentAdmissionsWindow(join(cacheDir, EXECUTION_PROVENANCE_FILENAME));
  return {
    async read({ now = Date.now() } = {}) {
      const [local, durations, recent, ...targets] = await Promise.all([
        Promise.resolve(sampleLocal()),
        readDurations(stackBaseDir),
        recentAdmissions.read(now),
        ...targetNames.map((targetName) => readTargetSnapshot(cacheDir, targetName, now)),
      ]);
      return { live: [local, ...targets], durations: durations ?? [],
        history: { recentAdmissions: recent.length, recentByTarget: summarizeByTarget(recent) } };
    },
  };
}

function bar(value, width = 10) {
  const normalized = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const filled = Math.round(normalized * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a';
}

export function formatExecutionFabricSummaryLines(summary) {
  const lines = ['live load:'];
  for (const target of summary.live) {
    if (!target.available && target.name !== 'primary') {
      lines.push(`  ${target.name.padEnd(12)} unavailable`);
      continue;
    }
    const normalizedLoad = Number.isFinite(target.load) && Number.isFinite(target.capacity) && target.capacity > 0
      ? target.load / target.capacity
      : null;
    const memoryFree = Number.isFinite(target.memAvailableKiB) && Number.isFinite(target.memTotalKiB) && target.memTotalKiB > 0
      ? target.memAvailableKiB / target.memTotalKiB
      : (Number.isFinite(target.freeRatio) ? target.freeRatio : null);
    const details = [
      `load ${Number(target.load ?? 0).toFixed(1)}/${target.capacity ?? '?'}`,
      target.name === 'primary' ? null : `jobs ${target.activeReservations ?? 0}/${target.capacity ?? '?'}`,
      `mem ${percent(memoryFree)} free`,
      Number.isFinite(target.cpuPsiAvg10) || Number.isFinite(target.memoryPsiAvg10)
        ? `psi ${Number(target.cpuPsiAvg10 ?? 0).toFixed(1)}/${Number(target.memoryPsiAvg10 ?? 0).toFixed(1)}`
        : null,
      Number.isFinite(target.cacheAgeSeconds) ? `age ${target.cacheAgeSeconds}s` : null,
    ].filter(Boolean);
    lines.push(`  ${target.name.padEnd(12)} ${bar(normalizedLoad)} ${details.join(' ')}`);
  }

  const recent = summary.history?.recentByTarget ?? [];
  lines.push('');
  lines.push(`last 60m: ${summary.history?.recentAdmissions ?? 0} dispatches`);
  for (const target of recent) {
    lines.push(`  ${target.target.padEnd(12)} ${bar(target.share)} ${String(target.count).padStart(4)} ${percent(target.share)}`);
  }

  const durations = summary.durations ?? [];
  if (durations.length > 0) {
    lines.push('');
    lines.push('run time p99 by class:');
    for (const entry of durations) {
      const seconds = Number.isFinite(entry.p99DurationMs) ? `${Math.round(entry.p99DurationMs / 1000)}s` : 'n/a';
      lines.push(`  ${String(entry.commandClass).padEnd(22)} ${seconds.padStart(7)} n=${entry.samples ?? 0}`);
    }
  }
  return lines;
}
