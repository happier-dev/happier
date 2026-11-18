import { randomUUID } from 'node:crypto';
import { appendFile, link, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
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
export const DURATION_WINDOW = 200;

const nativeDirectory = stackBaseDir => join(stackBaseDir, 'dev-target-command-load-native');

// Audit retention. Writers append to the active `provenance.jsonl`; the first row
// of a new UTC day seals it as `provenance.<first row ms>.<inode>.jsonl`, so
// `tail -n` on the active log shows the latest rows. Readers: the TUI fabric
// pane (last 60 min) and incident/queue audits, which read windows of hours up
// to a day and compare consecutive days (P03-QUEUE-AUDIT, P03-AUDIT-INFRA-1116).
// A week covers every such window; a sealed segment expires once all of its
// rows are older. Run-time history is the duration projection, not this log.
const DAY_MS = 24 * 60 * 60 * 1000;
const PROVENANCE_RETENTION_MS = 7 * DAY_MS;
const SEALED_SEGMENT = /^provenance\.(\d{13})\.\d+\.jsonl$/;
// Read granularity for backward scans, not a retention limit.
const SCAN_CHUNK_BYTES = 1024 * 1024;

/** The first row's timestamp; 0 when it has none. Shared with hstack-exec's due check. */
async function readFirstTimestamp(handle) {
  let line = '';
  for (let position = 0; ; position += SCAN_CHUNK_BYTES) {
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
    const { bytesRead } = await handle.read(chunk, 0, SCAN_CHUNK_BYTES, position);
    const text = chunk.subarray(0, bytesRead).toString('utf8');
    const newline = text.indexOf('\n');
    line += newline === -1 ? text : text.slice(0, newline);
    if (newline !== -1 || bytesRead < SCAN_CHUNK_BYTES) break;
  }
  // The last occurrence, like the shell check's greedy sed match.
  const at = line.lastIndexOf('"timestamp":');
  return at === -1 ? 0 : Number(/^\d*/.exec(line.slice(at + 12))[0] || 0);
}

async function listSealedSegments(directory) {
  let names;
  try { names = await readdir(directory); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  return names.flatMap(name => { const match = SEALED_SEGMENT.exec(name); return match ? [{ path: join(directory, name), name, first: Number(match[1]) }] : []; })
    .sort((left, right) => left.first - right.first || left.name.localeCompare(right.name));
}

/** Seal the active log when `now` falls on a later UTC day than its first row,
 * then expire sealed segments whose rows are all older than the retention.
 * Concurrent writers race safely: the sealed name derives from the active inode,
 * so only one `link` succeeds, and only that writer unlinks the active name. */
export async function rotateExecutionProvenance(directory, now = Date.now()) {
  const active = join(directory, EXECUTION_PROVENANCE_FILENAME);
  let handle;
  try { handle = await open(active, 'r'); } catch (error) { if (error?.code === 'ENOENT') return { sealed: null, expired: [] }; throw error; }
  let sealed, size;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) return { sealed: null, expired: [] };
    const first = await readFirstTimestamp(handle);
    if (Math.floor(first / DAY_MS) === Math.floor(now / DAY_MS)) return { sealed: null, expired: [] };
    sealed = join(directory, `provenance.${String(first).padStart(13, '0')}.${stat.ino}.jsonl`);
    size = stat.size;
  } finally { await handle.close(); }
  try { await link(active, sealed); } catch (error) { if (error?.code === 'EEXIST') return { sealed: null, expired: [] }; throw error; }
  await unlink(active);
  const segments = await listSealedSegments(directory);
  const expired = [];
  for (let index = 0; index < segments.length - 1; index++) {
    // The next segment's first row bounds every row of this one.
    if (segments[index + 1].first >= now - PROVENANCE_RETENTION_MS) break;
    await rm(segments[index].path, { force: true });
    expired.push(segments[index].name);
  }
  const sealedName = sealed.slice(directory.length + 1);
  process.stderr.write(`[execution-provenance] sealed ${sealedName} (${size} bytes)${expired.length ? `; expired ${expired.join(', ')}` : ''}\n`);
  return { sealed: sealedName, expired };
}

/** Complete lines of `handle` from the first row at or after `since` (by a
 * backward scan) to the end. Rows are appended in time order. */
export async function readExecutionProvenanceTail(handle, size, since) {
  let position = size;
  let buffer = Buffer.alloc(0);
  while (position > 0) {
    const length = Math.min(SCAN_CHUNK_BYTES, position);
    position -= length;
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    buffer = Buffer.concat([chunk.subarray(0, bytesRead), buffer]);
    // The oldest complete line read so far decides whether the window is covered.
    const start = position > 0 ? buffer.indexOf(10) + 1 : 0;
    const end = start > 0 || position === 0 ? buffer.indexOf(10, start) : -1;
    const head = start > 0 || position === 0 ? parseRow(buffer.subarray(start, end === -1 ? buffer.length : end).toString('utf8')) : null;
    if (head && head.timestamp < since) break;
  }
  // The first partial line belongs to an older record outside the window.
  return position > 0 ? buffer.subarray(buffer.indexOf(10) + 1) : buffer;
}

function parseRow(line) {
  if (!line) return null;
  try {
    const row = JSON.parse(line);
    return row && Number.isFinite(row.timestamp) ? row : null;
  } catch { return null; }
}

async function readSegmentSince(path, since) {
  let handle;
  try { handle = await open(path, 'r'); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return [];
    const bytes = await readExecutionProvenanceTail(handle, stat.size, since);
    return bytes.toString('utf8').split('\n').map(parseRow).filter(row => row && row.timestamp >= since);
  } finally { await handle.close(); }
}

/** Rows at or after `since` from sealed segments only, oldest first. A segment
 * is read only when its successor starts after `since`. */
export async function readSealedExecutionProvenanceSince(directory, since) {
  const segments = await listSealedSegments(directory);
  const rows = [];
  for (let index = segments.length - 1; index >= 0; index--) {
    rows.unshift(...await readSegmentSince(segments[index].path, since));
    if (segments[index].first < since) break;
  }
  return rows;
}

/** Rows at or after `since` across sealed segments and the active log, oldest first. */
export async function readExecutionProvenanceSince(directory, since) {
  return [...await readSealedExecutionProvenanceSince(directory, since),
    ...await readSegmentSince(join(directory, EXECUTION_PROVENANCE_FILENAME), since)];
}

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

export function nearestRankP99(durations) {
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
    // A controller-local test run admitted by --allow-local-test: why, and which files.
    if (record.localTestOverride) {
      normalized.localTestOverride = { reason: String(record.localTestOverride.reason ?? ''),
        files: (record.localTestOverride.files ?? []).map(String) };
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
  await rotateExecutionProvenance(directory, normalized.timestamp);
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
// hstack-exec --local --allow-local-test=<reason> audits its admitted selection here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--record-local-test-override') {
  const [stackBaseDir, commandClass, reason, ...files] = process.argv.slice(3);
  await appendExecutionProvenance(stackBaseDir, { phase: 'admitted', executionId: `local-test-${process.pid}-${Date.now()}`,
    timestamp: Date.now(), target: 'local', commandClass, syncStatus: 'local', localTestOverride: { reason, files } });
}
// hstack-exec's due check calls this once the active log's first row is from an earlier UTC day.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--rotate') {
  await rotateExecutionProvenance(process.argv[3], process.argv[4] ? Number(process.argv[4]) : Date.now());
}
// Audit reader: rows at or after a time (ms or ISO) across sealed segments, one JSON row per line.
// Latest rows only: `tail -n 50 <directory>/provenance.jsonl`. Never load the log whole.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--since') {
  const value = process.argv[3];
  const since = /^\d+$/.test(value ?? '') ? Number(value) : Date.parse(value ?? '');
  if (!Number.isFinite(since)) { process.stderr.write('usage: execution_provenance.mjs --since <ms|ISO time> <dev-target-command-load-native directory>\n'); process.exit(2); }
  for (const row of await readExecutionProvenanceSince(process.argv[4], since)) process.stdout.write(`${JSON.stringify(row)}\n`);
}
