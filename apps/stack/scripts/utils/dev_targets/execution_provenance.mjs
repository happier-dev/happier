import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const EXECUTION_PROVENANCE_SCHEMA_VERSION = 1;
export const EXECUTION_PROVENANCE_FILENAME = 'provenance.jsonl';

/** Successful completed native and JS executions share this recorded history.
 * Missing, unreadable or not-yet-completed observations supply no threshold. */
export async function readExecutionDurationP99(stackBaseDir, commandClass) {
  const durations = [];
  try {
    const history = createReadStream(join(stackBaseDir, 'dev-target-command-load-native', EXECUTION_PROVENANCE_FILENAME), { encoding: 'utf8' });
    for await (const line of createInterface({ input: history, crlfDelay: Infinity })) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.phase === 'completed' && record.commandClass === commandClass && record.exitCode === 0
        && record.signal == null && Number.isFinite(record.durationMs) && record.durationMs > 0) durations.push(record.durationMs);
    }
  } catch { return null; }
  durations.sort((left, right) => left - right);
  return durations[Math.ceil(durations.length * 0.99) - 1] ?? null;
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
    if (Number.isFinite(record.peakRssKiB)) normalized.peakRssKiB = record.peakRssKiB;
  }
  return normalized;
}

export async function appendExecutionProvenance(stackBaseDir, record) {
  const directory = join(stackBaseDir, 'dev-target-command-load-native');
  const path = join(directory, EXECUTION_PROVENANCE_FILENAME);
  await mkdir(directory, { recursive: true });
  await appendFile(path, `${JSON.stringify(normalizeRecord(record))}\n`, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--duration-p99') {
  const p99 = await readExecutionDurationP99(process.argv[3], process.argv[4]);
  if (p99 !== null) process.stdout.write(String(p99));
}
