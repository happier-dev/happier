import { readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_KEEP_COUNT = 8;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const RUNNER_LOG_NAME = /^(?:dev|run)\.(\d+)\.log$/;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export async function pruneStackRunnerLogs({
  logsDir,
  preservePaths = [],
  keepCount = DEFAULT_KEEP_COUNT,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
} = {}) {
  const preserved = new Set(
    preservePaths
      .map((path) => String(path ?? '').trim())
      .filter(Boolean)
      .map((path) => resolve(path)),
  );
  const entries = await readdir(logsDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = RUNNER_LOG_NAME.exec(entry.name);
    if (!match) continue;
    const path = resolve(logsDir, entry.name);
    const fileStat = await stat(path).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!fileStat) continue;
    candidates.push({ path, sequence: Number(match[1]), size: fileStat.size });
  }
  candidates.sort((left, right) => right.sequence - left.sequence || left.path.localeCompare(right.path));

  const historyLimit = positiveInteger(keepCount, DEFAULT_KEEP_COUNT);
  const byteLimit = positiveInteger(maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  let historyCount = 0;
  let historyBytes = 0;
  const keptPaths = [];
  const removedPaths = [];
  for (const candidate of candidates) {
    if (preserved.has(candidate.path)) {
      keptPaths.push(candidate.path);
      continue;
    }
    const fitsBudget = historyBytes + candidate.size <= byteLimit;
    if (historyCount < historyLimit && (fitsBudget || historyCount === 0)) {
      historyCount += 1;
      historyBytes += candidate.size;
      keptPaths.push(candidate.path);
      continue;
    }
    await rm(candidate.path, { force: true });
    removedPaths.push(candidate.path);
  }

  return { keptPaths, removedPaths };
}
