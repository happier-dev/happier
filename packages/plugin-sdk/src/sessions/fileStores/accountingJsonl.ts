/** @moduleRealm daemon */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { opendir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AgentExternalSessionAccountingObservation,
  AgentExternalSessionsInvocation,
  AgentExternalSessionsReadAccountingResult,
  AgentExternalSessionsResult,
} from '../../externalSessions.js';
import { getAgentExternalSessionsInvocationFailure, createAgentExternalSessionsProducerOverflowFailure } from '../../externalSessions.js';

// Invocation-owned scalar codec state; never holds raw records or spend facts.
export type AgentAccountingJsonlState = Record<string, string>;
type RecordWitness = { start: number; end: number; hash: string };
type Frontier = { identity: string; size: number; mtime: number; offset: number; state: AgentAccountingJsonlState; lastRecord?: RecordWitness };
type Cursor = { v: 1; source: string; files: Record<string, Frontier>; incomplete: boolean; incompleteReason?: string };
export type AgentAccountingJsonlProjection = Readonly<{
  state: AgentAccountingJsonlState;
  observations: readonly AgentExternalSessionAccountingObservation[];
  incomplete?: boolean;
  incompleteReason?: string;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hash(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function encode(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
function decode(raw: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (!record(value) || value.v !== 1 || typeof value.source !== 'string' || !record(value.files) || typeof value.incomplete !== 'boolean') return null;
    const files: Record<string, Frontier> = {};
    for (const [key, entry] of Object.entries(value.files)) {
      if (!record(entry) || typeof entry.identity !== 'string' || !record(entry.state)) return null;
      if (!['size', 'mtime', 'offset'].every((field) => typeof entry[field] === 'number' && Number.isFinite(entry[field]) && Number(entry[field]) >= 0)) return null;
      if (!Object.values(entry.state).every((field) => typeof field === 'string') || Number(entry.offset) > Number(entry.size)) return null;
      let lastRecord: RecordWitness | undefined;
      if (entry.lastRecord !== undefined) {
        const witness = entry.lastRecord;
        if (!record(witness) || typeof witness.hash !== 'string' || !witness.hash
          || typeof witness.start !== 'number' || !Number.isSafeInteger(witness.start) || witness.start < 0
          || typeof witness.end !== 'number' || !Number.isSafeInteger(witness.end)
          || witness.end <= witness.start || witness.end > Number(entry.offset)) return null;
        lastRecord = { start: witness.start, end: witness.end, hash: witness.hash };
      }
      files[key] = { identity: entry.identity, size: Number(entry.size), mtime: Number(entry.mtime), offset: Number(entry.offset), state: entry.state as AgentAccountingJsonlState,
        ...(lastRecord ? { lastRecord } : {}) };
    }
    return { v: 1, source: value.source, files, incomplete: value.incomplete,
      ...(typeof value.incompleteReason === 'string' ? { incompleteReason: value.incompleteReason } : {}) };
  } catch { return null; }
}
export async function discoverAgentAccountingJsonlSource(roots: readonly string[], signal: AbortSignal): Promise<Readonly<{
  files: readonly string[]; topologyDirectories: readonly string[]; available: boolean;
}>> {
  const files: string[] = [];
  const directories = new Set(roots);
  async function walk(path: string): Promise<void> {
    signal.throwIfAborted();
    const directory = await opendir(path);
    directories.add(path);
    for await (const entry of directory) {
      signal.throwIfAborted();
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(child);
    }
  }
  let available = false;
  for (const root of roots) {
    const info = await stat(root).catch((error: unknown) => {
      if (record(error) && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) continue;
    available = true;
    if (info.isDirectory()) await walk(root);
    else if (info.isFile() && root.endsWith('.jsonl')) files.push(root);
  }
  return { files: [...new Set(files)].sort(), topologyDirectories: [...directories].sort(), available };
}
function identity(info: Awaited<ReturnType<typeof stat>>): string {
  return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
}

async function* completeRecords(path: string, startOffset: number, size: number, signal: AbortSignal,
  onPartial: () => void): AsyncGenerator<Readonly<{ value: unknown; malformed: boolean; offset: number; endOffset: number; hash?: string }>> {
  if (startOffset === size) return;
  const stream = createReadStream(path, { start: startOffset, end: size - 1, signal });
  let carry = Buffer.alloc(0); let offset = startOffset;
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const buffer = Buffer.concat([carry, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      let start = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] !== 10) continue;
        const line = buffer.subarray(start, index).toString('utf8').trim();
        const endOffset = offset + index + 1 - start;
        if (line) {
          let value: unknown; let malformed = false;
          try { value = JSON.parse(line); } catch { malformed = true; }
          yield { value, malformed, offset, endOffset, hash: createHash('sha256').update(buffer.subarray(start, index + 1)).digest('base64url') };
        } else yield { value: null, malformed: false, offset, endOffset };
        offset = endOffset; start = index + 1;
      }
      carry = buffer.subarray(start);
    }
    if (carry.length > 0) onPartial();
  } finally { stream.destroy(); }
}

async function matchesRecordWitness(path: string, witness: RecordWitness, signal: AbortSignal): Promise<boolean> {
  const stream = createReadStream(path, { start: witness.start, end: witness.end - 1, signal });
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      digest.update(buffer); bytes += buffer.length;
    }
    return bytes === witness.end - witness.start && digest.digest('base64url') === witness.hash;
  } finally { stream.destroy(); }
}

/** Source-owned frontier over complete appended JSONL records. Raw records are
 * released after projection; only normalized accounting and codec state survive.
 * The caller's existing serialized-result budget controls page size. */
export async function readAgentAccountingJsonlSource(params: Readonly<{
  roots: readonly string[];
  sourceKey: string;
  cursor?: string;
  invocation: AgentExternalSessionsInvocation;
  projectRecord: (record: unknown, state: AgentAccountingJsonlState, filePath: string, recordOffsetBytes: number,
    context: Readonly<{ readFileState(filePath: string): Promise<Readonly<{ state: AgentAccountingJsonlState; complete: boolean }> | null> }>)
    => AgentAccountingJsonlProjection | Promise<AgentAccountingJsonlProjection>;
}>): Promise<AgentExternalSessionsResult<AgentExternalSessionsReadAccountingResult>> {
  const stopped = getAgentExternalSessionsInvocationFailure(params.invocation);
  if (stopped) return stopped;
  const source = hash(params.sourceKey);
  const previous = params.cursor ? decode(params.cursor) : null;
  const ok = (value: AgentExternalSessionsReadAccountingResult): AgentExternalSessionsResult<AgentExternalSessionsReadAccountingResult> => ({ ok: true, value });
  if (params.cursor && (!previous || previous.source !== source)) return ok({ outcome: 'gap_or_cursor_expired' });
  const cursor: Cursor = previous ? { ...previous, files: { ...previous.files } } : { v: 1, source, files: {}, incomplete: false };
  const observations: AgentExternalSessionAccountingObservation[] = [];
  let changed = !previous;
  let partial = false;
  const result = (pagePending = false) => ok({ outcome: 'advanced', observations, nextCursor: encode(cursor),
    coverage: { complete: !cursor.incomplete && !partial && !pagePending,
      ...(cursor.incomplete ? { reason: cursor.incompleteReason ?? 'unrecognized_accounting_record' } : partial ? { reason: 'partial_appended_record' } : pagePending ? { reason: 'reading' } : {}) } });
  const fits = (value: unknown) => params.invocation.maxSerializedBytes === undefined
    || Buffer.byteLength(JSON.stringify(value)) <= params.invocation.maxSerializedBytes;
  try {
    const inventory = await discoverAgentAccountingJsonlSource(params.roots, params.invocation.signal);
    if (!inventory.available) return ok({ outcome: 'source_unavailable' });
    const paths = inventory.files;
    const discovered = new Set(paths.map(hash));
    for (const key of Object.keys(cursor.files)) {
      if (discovered.has(key)) continue;
      // Cleanup of one native file does not invalidate witnessed append offsets
      // and lineage in the other files. Missing history remains explicit.
      delete cursor.files[key];
      changed = true;
      cursor.incomplete = true;
      cursor.incompleteReason = 'native_source_history_unavailable';
    }
    const stateReads = new Map<string, Promise<Readonly<{ state: AgentAccountingJsonlState; complete: boolean }> | null>>();
    const readingStates = new Set<string>();
    const context = { async readFileState(path: string): Promise<Readonly<{ state: AgentAccountingJsonlState; complete: boolean }> | null> {
      const canonical = await realpath(path).catch(() => null);
      if (!canonical || !discovered.has(hash(canonical)) || readingStates.has(canonical)) return null;
      const retained = cursor.files[hash(canonical)];
      const info = await stat(canonical);
      if (retained && retained.identity === identity(info) && retained.size === info.size && retained.mtime === info.mtimeMs && retained.offset === info.size) {
        return { state: retained.state, complete: true };
      }
      const existing = stateReads.get(canonical); if (existing) return existing;
      const read = (async () => {
        readingStates.add(canonical);
        let state: AgentAccountingJsonlState = {}; let complete = true;
        try {
          for await (const item of completeRecords(canonical, 0, info.size, params.invocation.signal, () => { complete = false; })) {
            const stopped = getAgentExternalSessionsInvocationFailure(params.invocation); if (stopped) { complete = false; break; }
            if (item.malformed) { complete = false; continue; }
            if (item.value === null) continue;
            const projection = await params.projectRecord(item.value, state, canonical, item.offset, context);
            state = projection.state;
          }
          const after = await stat(canonical);
          complete &&= identity(after) === identity(info) && after.size === info.size && after.mtimeMs === info.mtimeMs;
          return { state, complete };
        } finally { readingStates.delete(canonical); }
      })();
      stateReads.set(canonical, read); return read;
    } };
    for (const path of paths) {
      const interrupted = getAgentExternalSessionsInvocationFailure(params.invocation); if (interrupted) return interrupted;
      const key = hash(path); const info = await stat(path); const prior = cursor.files[key];
      if (prior && prior.identity !== identity(info)) return ok({ outcome: 'source_replaced' });
      if (prior && (info.size < prior.size || (info.size === prior.size && info.mtimeMs !== prior.mtime))) {
        return ok({ outcome: 'gap_or_cursor_expired' });
      }
      if (prior && info.size === prior.size && info.mtimeMs === prior.mtime) continue;
      // Only metadata changes require a content read. The exact retained final
      // record distinguishes append from a larger truncate/rewrite between scans.
      if (prior && prior.offset > 0 && (!prior.lastRecord
        || !await matchesRecordWitness(path, prior.lastRecord, params.invocation.signal))) {
        return ok({ outcome: 'gap_or_cursor_expired' });
      }
      changed = true;
      const frontier: Frontier = { identity: identity(info), size: info.size, mtime: info.mtimeMs, offset: prior?.offset ?? 0, state: { ...prior?.state },
        ...(prior?.lastRecord ? { lastRecord: prior.lastRecord } : {}) };
      cursor.files[key] = frontier;
      if (frontier.offset === info.size) continue;
      for await (const item of completeRecords(path, frontier.offset, info.size, params.invocation.signal, () => { partial = true; })) {
          const interruptedRead = getAgentExternalSessionsInvocationFailure(params.invocation); if (interruptedRead) return interruptedRead;
            const oldState = params.invocation.maxSerializedBytes === undefined ? frontier.state : { ...frontier.state };
            const oldOffset = frontier.offset; const oldIncomplete = cursor.incomplete; const oldReason = cursor.incompleteReason;
            const oldWitness = frontier.lastRecord;
            let projection: AgentAccountingJsonlProjection = { state: frontier.state, observations: [] };
            if (item.malformed) projection = { state: frontier.state, observations: [], incomplete: true };
            else if (item.value !== null) {
              try { projection = await params.projectRecord(item.value, frontier.state, path, item.offset, context); }
              catch { projection = { state: frontier.state, observations: [], incomplete: true }; }
            }
            frontier.state = projection.state; frontier.offset = item.endOffset;
            if (item.hash) frontier.lastRecord = { start: item.offset, end: item.endOffset, hash: item.hash };
            cursor.incomplete ||= projection.incomplete === true;
            if (projection.incompleteReason) cursor.incompleteReason = projection.incompleteReason;
            observations.push(...projection.observations);
            if (params.invocation.maxSerializedBytes !== undefined && !fits(result(true))) {
              observations.splice(observations.length - projection.observations.length);
              frontier.state = oldState; frontier.offset = oldOffset; cursor.incomplete = oldIncomplete;
              frontier.lastRecord = oldWitness;
              cursor.incompleteReason = oldReason;
              // A budget pause is ready work, unlike an unchanged partial tail.
              frontier.size = oldOffset;
              const page = result(true);
              return fits(page) && (observations.length > 0 || oldOffset > (prior?.offset ?? 0))
                ? page : createAgentExternalSessionsProducerOverflowFailure('Accounting record or source frontier exceeds the admitted result budget.');
            }
      }
      const after = await stat(path);
      if (identity(after) !== frontier.identity) return ok({ outcome: 'source_replaced' });
      if (after.size < frontier.offset) return ok({ outcome: 'gap_or_cursor_expired' });
    }
    const interrupted = getAgentExternalSessionsInvocationFailure(params.invocation); if (interrupted) return interrupted;
    if (!changed) return ok({ outcome: 'unchanged' });
    const page = result();
    return fits(page) ? page : createAgentExternalSessionsProducerOverflowFailure('Accounting source frontier exceeds the admitted result budget.');
  } catch (error) {
    const interrupted = getAgentExternalSessionsInvocationFailure(params.invocation); if (interrupted) return interrupted;
    return ok({ outcome: error instanceof Error && error.message === 'accounting_source_unavailable' ? 'source_unavailable' : 'read_failed' });
  }
}
