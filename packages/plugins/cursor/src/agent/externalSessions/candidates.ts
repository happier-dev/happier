import { lstat, open } from 'node:fs/promises';
import type { AgentExternalSessionCandidate, AgentExternalSessionsListCandidatesRequest, AgentExternalSessionsListCandidatesResult, AgentExternalSessionsResult } from '@happier-dev/plugin-sdk/sessions/external';
import { createAgentExternalSessionsProducerOverflowFailure, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionContentSearchControl, ExternalSessionContentSearchYield, readJsonlFileForward, searchExternalSessionContent } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { isRecord } from '@happier-dev/plugin-sdk';
import { discoverCursorNativeFiles, readCursorMetadata, type CursorNativeFile, type CursorNativeSource } from './source.js';
import { CURSOR_CLI_SOURCE, CursorCliStoreFormatError, discoverCursorCliStores, readCursorCliStoreHead, readCursorCliStoreWorkingDirectory, type CursorCliStoreConversation } from './cliStore.js';
import { cursorFileWitness, decodeCursorNativeRecord, encodeCursor, type CursorFileWitness } from './transcript.js';

type Scan = { v: 1; kind: 'cursorCandidates'; homeDir: string; query: string; target: string; after: string; incomplete?: boolean;
  current?: { path: string; position: number; ordinal: number; witness: CursorFileWitness } };
function decode(raw: string): Scan | null {
  try {
    const data: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (!isRecord(data) || data.v !== 1 || data.kind !== 'cursorCandidates' || typeof data.homeDir !== 'string'
      || typeof data.query !== 'string' || typeof data.target !== 'string' || typeof data.after !== 'string') return null;
    if (data.current !== undefined) {
      const c = data.current;
      if (!isRecord(c) || typeof c.path !== 'string' || typeof c.position !== 'number' || !Number.isSafeInteger(c.position) || c.position < 0
        || typeof c.ordinal !== 'number' || !Number.isSafeInteger(c.ordinal) || c.ordinal < 0 || !isRecord(c.witness)) return null;
      const w = c.witness;
      if (typeof w.identity !== 'string' || typeof w.size !== 'number' || !Number.isSafeInteger(w.size) || w.size < c.position
        || typeof w.prefix !== 'string' || typeof w.modified !== 'string') return null;
      return { v: 1, kind: 'cursorCandidates', homeDir: data.homeDir, query: data.query, target: data.target, after: data.after, incomplete: data.incomplete === true,
        current: { path: c.path, position: c.position, ordinal: c.ordinal,
          witness: { identity: w.identity, size: w.size, prefix: w.prefix, modified: w.modified } } };
    }
    return { v: 1, kind: 'cursorCandidates', homeDir: data.homeDir, query: data.query, target: data.target, after: data.after, incomplete: data.incomplete === true };
  } catch { return null; }
}

export async function listCursorNativeCandidates(root: CursorNativeSource, request: AgentExternalSessionsListCandidatesRequest): Promise<AgentExternalSessionsResult<AgentExternalSessionsListCandidatesResult>> {
  const query = request.searchTerm ?? ''; const target = request.searchTarget ?? 'metadata';
  const previous = request.cursor ? decode(request.cursor) : null;
  if (request.cursor && (!previous || previous.homeDir !== root.homeDir || previous.query !== query || previous.target !== target)) {
    return { ok: false, code: 'invalid_request', message: 'Cursor continuation does not match this source/query.' };
  }
  const scan: Scan = previous ?? { v: 1, kind: 'cursorCandidates', homeDir: root.homeDir, query, target, after: '' };
  const inventory = await discoverCursorNativeFiles(root, request.signal);
  if (scan.current && !inventory.files.some(file => file.path === scan.current!.path)) return { ok: false, code: 'source_invalid' };
  const stores = await discoverCursorCliStores(root.homeDir, request.signal);
  type Entry = Readonly<{ path: string; file?: CursorNativeFile; store?: CursorCliStoreConversation }>;
  const entries: Entry[] = [...inventory.files.map(file => ({ path: file.path, file })),
    ...stores.conversations.map(store => ({ path: store.storePath, store }))]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const candidates: AgentExternalSessionCandidate[] = [];
  let partial = scan.incomplete === true; let unfinished = false;
  const result = (more: boolean): AgentExternalSessionsResult<AgentExternalSessionsListCandidatesResult> => ({ ok: true, value: {
    candidates, nextCursor: more ? encodeCursor(scan) : null,
    ...(target === 'content' ? { contentCoverage: partial || more ? 'partial' : 'complete' } : {}),
    ...(partial || more ? { searchIncomplete: true } : {}),
  } });
  const control = createExternalSessionContentSearchControl({ signal: request.signal,
    deadlineAtMs: request.scanDeadlineAtMs ?? request.deadlineAtMs });
  for (const entry of entries) {
    if (entry.path <= scan.after) continue;
    request.signal.throwIfAborted();
    if (candidates.length >= request.maxItems) { unfinished = true; break; }
    if (entry.store) {
      const store = entry.store;
      scan.after = entry.path;
      // Store conversations are listed by metadata; their bodies are not content-searched yet.
      if (target === 'content' && query) { partial = true; continue; }
      const stored = await readCursorCliStoreCandidate(store, request);
      if (!stored) continue;
      if (query && ![stored.title ?? '', stored.cwd ?? '', stored.remoteSessionId].some(text => text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) continue;
      candidates.push(stored);
      if (!isAgentExternalSessionsResultWithinByteBudget(result(true), request.maxSerializedBytes)) {
        candidates.pop();
        if (!candidates.length) return createAgentExternalSessionsProducerOverflowFailure('Cursor candidate cannot fit the caller result budget.');
        scan.after = entries[entries.indexOf(entry) - 1]?.path ?? '';
        unfinished = true; break;
      }
      continue;
    }
    const file = entry.file!;
    // A fresh request may yield before any body work. A retained native step
    // gets one indivisible row on resume, preventing equal-budget starvation.
    if (!scan.current && request.scanDeadlineAtMs !== undefined && Date.now() >= request.scanDeadlineAtMs) { unfinished = true; break; }
    const metadata = await readCursorMetadata(file);
    const info = await lstat(file.path);
    const candidate: AgentExternalSessionCandidate = { remoteSessionId: file.id, title: metadata.title ?? file.id,
      ...(metadata.cwd === undefined ? {} : { cwd: metadata.cwd }),
      ...(metadata.createdAtMs === undefined ? {} : { createdAtMs: metadata.createdAtMs }),
      updatedAtMs: metadata.updatedAtMs ?? info.mtimeMs };
    if (!metadata.supported) { partial = true; scan.after = file.path; delete scan.current; continue; }
    if (target === 'content' && query) {
      if (!scan.current) scan.current = { path: file.path, position: 0, ordinal: 0,
        witness: await cursorFileWitness(file.path, undefined, request.signal) };
      const progress = scan.current;
      if (progress.path !== file.path) return { ok: false, code: 'source_invalid' };
      const current = await cursorFileWitness(file.path, progress.witness.size, request.signal, progress.witness);
      if (current.identity !== progress.witness.identity || current.prefix !== progress.witness.prefix) return { ok: false, code: 'source_invalid' };
      let complete = false;
      try {
        const hit = await searchExternalSessionContent({ query,
          ...(previous?.current ? {} : { paths: [file.path], ripgrep: request.ripgrep }), control,
          isScanComplete: () => complete,
          async decode(matchText) {
            let found: { id: string; snippet: string; messageIndex: number } | undefined;
            let sourcePartial = false;
            await control.prepare(async () => {
              const page = await readJsonlFileForward({ filePath: file.path, offsetBytes: progress.position,
                maxBytes: request.maxSerializedBytes, maxItems: 1, maxOversizeLineBytes: progress.witness.size,
                includeMalformedRecords: true,
                fileSystem: { stat: async () => ({ size: progress.witness.size, mtimeMs: info.mtimeMs }),
                  async read(path, position, length) {
                    request.signal.throwIfAborted();
                    const handle = await open(path, 'r');
                    try { const buffer = Buffer.alloc(length); const read = await handle.read(buffer, 0, length, position); return buffer.subarray(0, read.bytesRead); }
                    finally { await handle.close(); }
                  } },
              });
              for (const line of page.items) {
                const record = decodeCursorNativeRecord(line.value, line.startOffsetBytes, metadata.createdAtMs ?? info.mtimeMs);
                const snippet = record.text === undefined ? null : matchText(record.text);
                if (snippet !== null) found = { id: record.item.id, snippet, messageIndex: progress.ordinal };
                sourcePartial ||= record.partial;
                scan.incomplete ||= record.partial;
                progress.ordinal += 1;
              }
              sourcePartial ||= !!page.diagnostics?.length || page.truncated;
              scan.incomplete ||= sourcePartial;
              const advanced = page.nextOffsetBytes > progress.position;
              progress.position = page.nextOffsetBytes;
              complete = page.reachedEnd || !!found || !advanced;
              if (!advanced && !page.reachedEnd) sourcePartial = true;
              return complete;
            });
            return { records: found ? [found] : [], partial: sourcePartial };
          },
        });
        partial ||= hit.partial || scan.incomplete === true;
        const verified = await cursorFileWitness(file.path, progress.witness.size, request.signal, progress.witness);
        if (verified.identity !== progress.witness.identity || verified.prefix !== progress.witness.prefix) return { ok: false, code: 'source_invalid' };
        if (hit.match) {
          candidates.push({ ...candidate, match: hit.match });
        }
      } catch (error) {
        if (!(error instanceof ExternalSessionContentSearchYield)) throw error;
        unfinished = true; break;
      }
    } else if (!query || [candidate.title ?? '', candidate.cwd ?? '', file.id].some(text => text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) candidates.push(candidate);
    scan.after = file.path; delete scan.current;
    if (!isAgentExternalSessionsResultWithinByteBudget(result(true), request.maxSerializedBytes)) {
      // Revisit the unreturned candidate; never advance past a dropped hit.
      candidates.pop();
      if (!candidates.length) return createAgentExternalSessionsProducerOverflowFailure('Cursor candidate cannot fit the caller result budget.');
      scan.after = entries[entries.indexOf(entry) - 1]?.path ?? '';
      unfinished = true; break;
    }
  }
  return result(unfinished);
}

/**
 * One row per root conversation; a subagent store belongs to its root. An
 * unrecognised store still lists as a row so its open reports the typed
 * unsupported-format failure instead of the row silently vanishing.
 */
async function readCursorCliStoreCandidate(store: CursorCliStoreConversation, request: AgentExternalSessionsListCandidatesRequest): Promise<AgentExternalSessionCandidate | null> {
  const linkData = { cursorSource: CURSOR_CLI_SOURCE };
  const updatedAtMs = await storeUpdatedAtMs(store);
  try {
    const { head, state } = await readCursorCliStoreHead(store, request.readCandidateIndexState?.({ remoteSessionId: store.id, linkData }));
    if (head.subagentOf !== null) return null;
    const cwd = await readCursorCliStoreWorkingDirectory(store);
    return { remoteSessionId: store.id, title: head.title ?? store.id, ...(cwd ? { cwd } : {}), createdAtMs: head.createdAtMs,
      updatedAtMs, linkData, ...(request.readCandidateIndexState ? { candidateIndexState: state } : {}) };
  } catch (error) {
    if (!(error instanceof CursorCliStoreFormatError)) throw error;
    return { remoteSessionId: store.id, title: store.id, updatedAtMs, linkData };
  }
}

async function storeUpdatedAtMs(store: CursorCliStoreConversation): Promise<number> {
  // An empty WAL (one a reader created) is not a Cursor write.
  const times = await Promise.all([store.storePath, `${store.storePath}-wal`].map(async (path) => {
    try { const info = await lstat(path); return info.size > 0 ? info.mtimeMs : 0; }
    catch (error) { if (isRecord(error) && error.code === 'ENOENT') return 0; throw error; }
  }));
  return Math.max(...times);
}
