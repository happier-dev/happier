import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXECUTION_PROVENANCE_SCHEMA_VERSION = 1;
export const EXECUTION_PROVENANCE_FILENAME = 'provenance.jsonl';
export const EXECUTION_DURATION_PROJECTION_FILENAME = 'duration-projection.json';
// Recent successful run durations kept per class. Nearest-rank p99 needs at
// least 100 observations to differ from the maximum; 200 keeps one outlier from
// defining it (p99 = second largest) while staying a few KiB per class. The
// append-only provenance log remains the audit record; dispatch and the TUI
// read only this projection (the log reached 811 MB / 1.91M lines, 2026-11-14).
const DURATION_WINDOW = 200;

const nativeDirectory = stackBaseDir => join(stackBaseDir, 'dev-target-command-load-native');

/** Class -> recent successful run durations, oldest first. */
export async function readExecutionDurationProjection(stackBaseDir) {
  let parsed;
  try { parsed = JSON.parse(await readFile(join(nativeDirectory(stackBaseDir), EXECUTION_DURATION_PROJECTION_FILENAME), 'utf8')); }
  catch { return {}; }
  const projection = {};
  for (const [commandClass, durations] of Object.entries(parsed?.durations ?? {})) {
    if (!Array.isArray(durations)) continue;
    const valid = durations.filter(value => Number.isFinite(value) && value > 0);
    if (valid.length) projection[commandClass] = valid;
  }
  return projection;
}

function nearestRankP99(durations) {
  const sorted = [...durations].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null;
}

/** Successful completed native and JS executions share this recorded history.
 * Missing, unreadable or not-yet-completed observations supply no threshold. */
export async function readExecutionDurationP99(stackBaseDir, commandClass) {
  return nearestRankP99((await readExecutionDurationProjection(stackBaseDir))[commandClass] ?? []);
}

export async function readExecutionDurationSummaries(stackBaseDir) {
  return Object.entries(await readExecutionDurationProjection(stackBaseDir))
    .map(([commandClass, durations]) => ({ commandClass, p99DurationMs: nearestRankP99(durations), samples: durations.length }))
    .sort((left, right) => left.commandClass.localeCompare(right.commandClass));
}

/** Fold one successful completion into the projection. Concurrent completions
 * replace the file atomically; a lost sample under a race only thins the window. */
export async function recordExecutionDuration(stackBaseDir, { commandClass, exitCode, signal, durationMs }) {
  if (exitCode !== 0 || signal != null || !Number.isFinite(durationMs) || durationMs <= 0
    || typeof commandClass !== 'string' || !commandClass) return;
  const projection = await readExecutionDurationProjection(stackBaseDir);
  projection[commandClass] = [...(projection[commandClass] ?? []), durationMs].slice(-DURATION_WINDOW);
  const directory = nativeDirectory(stackBaseDir);
  await mkdir(directory, { recursive: true });
  const target = join(directory, EXECUTION_DURATION_PROJECTION_FILENAME);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, durations: projection }), 'utf8');
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

function finiteNumber(value, fallback = null) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeRecord(record) {
  const normalized = {
    schemaVersion: EXECUTION_PROVENANCE_SCHEMA_VERSION,
    phase: record.phase === 'completed' ? 'completed' : 'admitted',
    executionId: String(record.executionId ?? ''),
    timestamp: finiteNumber(record.timestamp, 0),
    target: String(record.target ?? ''),
    commandClass: String(record.commandClass ?? 'unknown'),
  };
  if (normalized.phase === 'admitted') {
    normalized.syncStatus = String(record.syncStatus ?? 'unknown');
    normalized.syncSuccessfulCycles = finiteNumber(record.syncSuccessfulCycles, 0);
    for (const key of [
      'normalizedLoad', 'activeReservations', 'activeClassReservations', 'effectiveScore', 'capacity', 'runQueue',
      'memAvailableKiB', 'memTotalKiB', 'swapUsedKiB', 'swapTotalKiB', 'cpuPsiAvg10',
      'memoryPsiAvg10', 'ioPsiAvg10', 'swapInPages', 'swapOutPages', 'diskFreeKiB',
    ]) {
      if (Number.isFinite(record[key])) normalized[key] = record[key];
    }
    if (record.platform === 'linux' || record.platform === 'darwin') {
      normalized.platform = record.platform;
    }
  } else {
    normalized.exitCode = finiteNumber(record.exitCode);
    normalized.signal = record.signal == null ? null : String(record.signal);
    normalized.durationMs = finiteNumber(record.durationMs, 0);
    // Admitted run time on the worker's clock; durationMs keeps dispatch wall time.
    if (Number.isFinite(record.runMs) && record.runMs > 0) normalized.runMs = record.runMs;
    if (Number.isFinite(record.peakRssKiB)) normalized.peakRssKiB = record.peakRssKiB;
  }
  return normalized;
}

export async function appendExecutionProvenance(stackBaseDir, record) {
  const directory = join(stackBaseDir, 'dev-target-command-load-native');
  const path = join(directory, EXECUTION_PROVENANCE_FILENAME);
  await mkdir(directory, { recursive: true });
  const normalized = normalizeRecord(record);
  await appendFile(path, `${JSON.stringify(normalized)}\n`, 'utf8');
  if (normalized.phase === 'completed') {
    await recordExecutionDuration(stackBaseDir, { ...normalized, durationMs: normalized.runMs ?? normalized.durationMs });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--duration-p99') {
  const p99 = await readExecutionDurationP99(process.argv[3], process.argv[4]);
  if (p99 !== null) process.stdout.write(String(p99));
}
// The native launcher appends its own audit rows; it folds the completion here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--record-duration') {
  await recordExecutionDuration(process.argv[3], { commandClass: process.argv[4], exitCode: Number(process.argv[5]),
    signal: null, durationMs: Number(process.argv[6]) });
}
