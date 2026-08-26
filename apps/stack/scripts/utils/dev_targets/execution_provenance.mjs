import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const EXECUTION_PROVENANCE_SCHEMA_VERSION = 1;
export const EXECUTION_PROVENANCE_FILENAME = 'provenance.jsonl';
const EXECUTION_PROVENANCE_MAX_BYTES = 1024 * 1024;

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
  try {
    const current = await stat(path);
    if (current.size >= EXECUTION_PROVENANCE_MAX_BYTES) {
      await rename(path, `${path}.previous`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await appendFile(path, `${JSON.stringify(normalizeRecord(record))}\n`, 'utf8');
}
