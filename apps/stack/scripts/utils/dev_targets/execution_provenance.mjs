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

function validDurations(byClass) {
  const projection = {};
  for (const [commandClass, durations] of Object.entries(byClass ?? {})) {
    if (!Array.isArray(durations)) continue;
    const valid = durations.filter(value => Number.isFinite(value) && value > 0);
    if (valid.length) projection[commandClass] = valid;
  }
  return projection;
}

async function readProjectionFile(stackBaseDir) {
  try { return JSON.parse(await readFile(join(nativeDirectory(stackBaseDir), EXECUTION_DURATION_PROJECTION_FILENAME), 'utf8')); }
  catch { return null; }
}

/** Class -> recent successful run durations across every worker, oldest first. */
export async function readExecutionDurationProjection(stackBaseDir) {
  return validDurations((await readProjectionFile(stackBaseDir))?.durations);
}

function nearestRankP99(durations) {
  const sorted = [...durations].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null;
}

/** Successful completed native and JS executions share this recorded history.
 * Workers differ several-fold in speed (linux1 runs targeted validation ~3x
 * slower than nl1/nl3, P03-QUEUE-2), so a worker's own runs decide its p99;
 * a worker without its own history uses the class history of every worker.
 * Missing, unreadable or not-yet-completed observations supply no threshold. */
export async function readExecutionDurationP99(stackBaseDir, commandClass, target) {
  const parsed = await readProjectionFile(stackBaseDir);
  const own = target ? validDurations(parsed?.targets?.[target])[commandClass] : undefined;
  return nearestRankP99(own ?? validDurations(parsed?.durations)[commandClass] ?? []);
}

/** Worker -> its own p99 for one class, for workers that have history. */
export async function readExecutionDurationP99ByTarget(stackBaseDir, commandClass) {
  const parsed = await readProjectionFile(stackBaseDir);
  const result = {};
  for (const target of Object.keys(parsed?.targets ?? {}).sort()) {
    const durations = validDurations(parsed.targets[target])[commandClass];
    if (durations) result[target] = nearestRankP99(durations);
  }
  return result;
}

export async function readExecutionDurationSummaries(stackBaseDir) {
  return Object.entries(await readExecutionDurationProjection(stackBaseDir))
    .map(([commandClass, durations]) => ({ commandClass, p99DurationMs: nearestRankP99(durations), samples: durations.length }))
    .sort((left, right) => left.commandClass.localeCompare(right.commandClass));
}

/** Fold one successful completion into the projection. Concurrent completions
 * replace the file atomically; a lost sample under a race only thins the window. */
export async function recordExecutionDuration(stackBaseDir, { commandClass, target: worker, exitCode, signal, durationMs }) {
  if (exitCode !== 0 || signal != null || !Number.isFinite(durationMs) || durationMs <= 0
    || typeof commandClass !== 'string' || !commandClass) return;
  const parsed = await readProjectionFile(stackBaseDir);
  const append = durations => [...(durations ?? []), durationMs].slice(-DURATION_WINDOW);
  const projection = validDurations(parsed?.durations);
  projection[commandClass] = append(projection[commandClass]);
  const targets = {};
  for (const [name, byClass] of Object.entries(parsed?.targets ?? {})) targets[name] = validDurations(byClass);
  if (typeof worker === 'string' && worker) {
    targets[worker] ??= {};
    targets[worker][commandClass] = append(targets[worker][commandClass]);
  }
  const directory = nativeDirectory(stackBaseDir);
  await mkdir(directory, { recursive: true });
  const path = join(directory, EXECUTION_DURATION_PROJECTION_FILENAME);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, durations: projection, targets }), 'utf8');
    await rename(temporary, path);
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
  const p99 = await readExecutionDurationP99(process.argv[3], process.argv[4], process.argv[5]);
  if (p99 !== null) process.stdout.write(String(p99));
}
// Placement: one "<worker> <p99Ms>" line per worker with history for the class.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--duration-p99-targets') {
  const byTarget = await readExecutionDurationP99ByTarget(process.argv[3], process.argv[4]);
  for (const [target, p99] of Object.entries(byTarget)) process.stdout.write(`${target} ${p99}\n`);
}
// The native launcher appends its own audit rows; it folds the completion here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--record-duration') {
  await recordExecutionDuration(process.argv[3], { commandClass: process.argv[4], exitCode: Number(process.argv[5]),
    signal: null, durationMs: Number(process.argv[6]), target: process.argv[7] });
}
