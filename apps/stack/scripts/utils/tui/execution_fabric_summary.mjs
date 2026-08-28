import { readFile, readdir } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';

const HISTORY_WINDOW_MS = 60 * 60 * 1000;

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

function parseProvenanceFiles(rawFiles, now) {
  const admissions = [];
  for (const raw of rawFiles) {
    for (const line of String(raw ?? '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record?.schemaVersion === 1 && record.phase === 'admitted' && record.target) {
          admissions.push(record);
        }
      } catch {
        // A concurrently appended final line is incomplete until the next refresh.
      }
    }
  }

  const summarize = (records) => {
    const grouped = new Map();
    for (const record of records) {
      const target = String(record.target);
      const current = grouped.get(target) ?? { target, count: 0, loads: [] };
      current.count += 1;
      if (Number.isFinite(record.normalizedLoad)) current.loads.push(record.normalizedLoad);
      grouped.set(target, current);
    }
    const total = records.length;
    return [...grouped.values()].map((entry) => ({
      target: entry.target,
      count: entry.count,
      share: total > 0 ? entry.count / total : 0,
      averageNormalizedLoad: entry.loads.length > 0
        ? entry.loads.reduce((sum, value) => sum + value, 0) / entry.loads.length
        : null,
    }));
  };

  const recent = admissions.filter((record) => (
    Number.isFinite(record.timestamp) && record.timestamp >= now - HISTORY_WINDOW_MS
  ));
  return {
    retainedAdmissions: admissions.length,
    retainedByTarget: summarize(admissions),
    recentAdmissions: recent.length,
    recentByTarget: summarize(recent),
  };
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

export function createExecutionFabricSummaryReader({
  stackBaseDir,
  targetNames,
  historyRefreshMs = 15_000,
  sampleLocal = defaultLocalSample,
}) {
  const cacheDir = join(stackBaseDir, 'dev-target-command-load-native');
  let cachedHistory = null;
  let historySampledAt = 0;
  return {
    async read({ now = Date.now() } = {}) {
      const [local, ...targets] = await Promise.all([
        Promise.resolve(sampleLocal()),
        ...targetNames.map((targetName) => readTargetSnapshot(cacheDir, targetName, now)),
      ]);
      if (!cachedHistory || now - historySampledAt >= historyRefreshMs) {
        const rawFiles = await Promise.all([
          readText(join(cacheDir, 'provenance.jsonl.previous')),
          readText(join(cacheDir, 'provenance.jsonl')),
        ]);
        cachedHistory = parseProvenanceFiles(rawFiles, now);
        historySampledAt = now;
      }
      return { live: [local, ...targets], history: cachedHistory };
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

  const retained = summary.history?.retainedByTarget ?? [];
  lines.push(`retained dispatches: ${summary.history?.retainedAdmissions ?? 0}`);
  for (const target of retained) {
    const average = Number.isFinite(target.averageNormalizedLoad)
      ? ` avg load ${percent(target.averageNormalizedLoad)}`
      : '';
    lines.push(`  ${target.target.padEnd(12)} ${bar(target.share)} ${String(target.count).padStart(4)} ${percent(target.share)}${average}`);
  }
  return lines;
}
