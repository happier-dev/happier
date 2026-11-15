import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type {
  AgentExternalSessionsContribution, AgentExternalSessionsInvocation, AgentExternalSessionsResult,
  AgentExternalSessionsPageTranscriptRequest, AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';
import { createAgentExternalSessionsProducerOverflowFailure, getAgentExternalSessionsInvocationFailure, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { readJsonlFileBackwardPage, readJsonlFileForward } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { discoverCursorNativeFiles, readCursorMetadata, resolveCursorNativeSource, type CursorNativeSource } from './source.js';
import { cursorFileWitness, decodeCursorNativeRecord, decodeTranscriptCursor, encodeCursor, type CursorFileWitness } from './transcript.js';
import { listCursorNativeCandidates } from './candidates.js';
import { CURSOR_CLI_SOURCE, cursorCliStoreWatchFiles, discoverCursorCliStores } from './cliStore.js';
import { findCursorCliStore, isCursorCliStoreCursor, pageCursorCliStoreTranscript, readAfterCursorCliStoreTranscript } from './cliStoreTranscript.js';
import { describeCursorAppAccountingSource, listCursorAppCandidates, pageCursorAppTranscript, readAfterCursorAppTranscript, resolveCursorAppLinkIdentity, resolveCursorAppStore } from './appStore.js';

const ok = <T>(value: T): AgentExternalSessionsResult<T> => ({ ok: true, value });
async function run<T>(request: AgentExternalSessionsInvocation, work: () => Promise<AgentExternalSessionsResult<T>>): Promise<AgentExternalSessionsResult<T>> {
  const stopped = getAgentExternalSessionsInvocationFailure(request);
  if (stopped) return stopped;
  try { return await work(); }
  catch {
    const cancelled = getAgentExternalSessionsInvocationFailure(request);
    if (cancelled) return cancelled;
    return { ok: false, code: 'agent_unavailable', retryable: true };
  }
}
async function findFile(root: CursorNativeSource, id: string, signal: AbortSignal) {
  const matches = (await discoverCursorNativeFiles(root, signal)).files.filter(file => file.id === id);
  // An ambiguous native identity cannot select an arbitrary project transcript.
  return matches.length === 1 ? matches[0]! : null;
}
function samePrefix(a: CursorFileWitness, b: CursorFileWitness) { return a.identity === b.identity && a.size === b.size && a.prefix === b.prefix; }

// readAfter hands over the file it found and the prefix witness it already
// verified against the cursor, so one read neither re-walks nor re-hashes them.
type CursorVerifiedRead = Readonly<{ file: NonNullable<Awaited<ReturnType<typeof findFile>>>; prefix: CursorFileWitness }>;

async function page(root: CursorNativeSource, request: AgentExternalSessionsPageTranscriptRequest, verified?: CursorVerifiedRead): Promise<AgentExternalSessionsResult<AgentExternalSessionsTranscriptPage>> {
  const file = verified?.file ?? await findFile(root, request.remoteSessionId, request.signal);
  if (!file) return { ok: false, code: 'candidate_not_found' };
  const metadata = await readCursorMetadata(file);
  if (!metadata.supported) return { ok: false, code: 'unsupported' };
  const previous = request.cursor ? decodeTranscriptCursor(request.cursor) : null;
  if (request.cursor && (!previous || previous.homeDir !== root.homeDir || previous.id !== file.id)) return { ok: false, code: 'invalid_request' };
  let witness = verified?.prefix ?? await cursorFileWitness(file.path, previous?.witness.size, request.signal, previous?.witness);
  if (previous && !samePrefix(previous.witness, witness)) return { ok: false, code: 'source_invalid' };
  const info = await lstat(file.path);
  if (request.direction === 'newer' && info.size !== witness.size) witness = await cursorFileWitness(file.path, undefined, request.signal);
  const cursor = (position: number, captured = witness) => encodeCursor({ v: 1, kind: 'cursorTranscript', homeDir: root.homeDir, id: file.id, position, witness: captured });
  const raw = request.direction === 'older'
    ? await readJsonlFileBackwardPage({ filePath: file.path, endOffsetBytes: previous?.position ?? witness.size,
      maxBytes: request.maxSerializedBytes, maxItems: request.maxItems, maxOversizeLineBytes: witness.size, includeMalformedRecords: true })
    : await readJsonlFileForward({ filePath: file.path, offsetBytes: previous?.position ?? 0,
      maxBytes: request.maxSerializedBytes, maxItems: request.maxItems, maxOversizeLineBytes: info.size, includeMalformedRecords: true });
  request.signal.throwIfAborted();
  if (!samePrefix(witness, await cursorFileWitness(file.path, witness.size, request.signal, witness))) return { ok: false, code: 'source_invalid' };
  const projected = raw.items.map(line => decodeCursorNativeRecord(line.value, line.startOffsetBytes, metadata.createdAtMs ?? info.mtimeMs));
  const items = projected.map(record => record.item);
  const older = 'nextEndOffsetBytes' in raw;
  const nextPosition = older ? raw.nextEndOffsetBytes : raw.nextOffsetBytes;
  const hasMore = older ? !raw.reachedStart : !raw.reachedEnd;
  const tailPosition = older ? raw.tailOffsetBytes ?? witness.size : nextPosition;
  const incompleteTail = older && tailPosition < witness.size;
  const tailWitness = tailPosition === witness.size ? witness : await cursorFileWitness(file.path, tailPosition, request.signal);
  const result = ok({ items, nextCursor: hasMore ? cursor(nextPosition) : null,
    tailCursor: cursor(tailPosition, tailWitness), hasMore,
    ...(projected.some(record => record.partial) || raw.diagnostics?.length || incompleteTail ? { diagnostics: [{ code: 'unsupported_native_record', severity: 'required' as const,
      count: projected.filter(record => record.partial).length + (raw.diagnostics?.length ?? 0) + (incompleteTail ? 1 : 0), positions: [] }] } : {}),
  });
  if (!isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes)) {
    if (request.maxItems > 1) return page(root, { ...request, maxItems: Math.max(1, Math.floor(request.maxItems / 2)) }, verified);
    return createAgentExternalSessionsProducerOverflowFailure('Cursor transcript record exceeds the caller result budget.');
  }
  return result;
}

type ReadAfterTranscriptValue = Awaited<ReturnType<AgentExternalSessionsContribution['readAfterTranscript']>> extends AgentExternalSessionsResult<infer V> ? V : never;

export const cursorExternalSessionsContribution: AgentExternalSessionsContribution = {
  resolveSource(request) { return run(request, async () => {
    // The Cursor app (`cursorApp`) is its own source with its own store and watch resource.
    if (request.source.kind === 'cursorApp') {
      const app = await resolveCursorAppStore(request.source);
      if (!app) return { ok: false, code: 'source_invalid' };
      return ok(request.includeAccountingSource === false ? { source: app.source } : { source: app.source, accountingSource: describeCursorAppAccountingSource(app) });
    }
    const root = await resolveCursorNativeSource(request.source);
    if (!root) return { ok: false, code: 'source_invalid' };
    if (request.includeAccountingSource === false) return ok({ source: root.source });
    const inventory = await discoverCursorNativeFiles(root, request.signal);
    const stores = await discoverCursorCliStores(root.homeDir, request.signal);
    return ok({ source: root.source, accountingSource: {
      rootPath: root.homeDir, resourceKey: `cursor:transcripts:${createHash('sha256').update(root.homeDir).digest('base64url')}`,
      changeObservation: 'watch_file_changes' as const, watchFileChanges: {
        // CLI stores commit through their WAL; the database and WAL files are watched, never polled.
        files: [...inventory.files.map(file => file.path), ...inventory.metadataFiles, ...stores.conversations.flatMap(cursorCliStoreWatchFiles)],
        topologyDirectories: [...new Set([...inventory.directories, ...stores.directories])],
      },
    } });
  }); },
  listCandidates(request) { return run(request, async () => {
    if (request.source.kind === 'cursorApp') {
      const app = await resolveCursorAppStore(request.source);
      return app ? listCursorAppCandidates(app, request) : { ok: false, code: 'source_invalid' };
    }
    const root = await resolveCursorNativeSource(request.source);
    if (!root) return { ok: false, code: 'source_invalid' };
    return listCursorNativeCandidates(root, request);
  }); },
  resolveLinkIdentity(request) { return run(request, async () => {
    if (request.source.kind === 'cursorApp') {
      const app = await resolveCursorAppStore(request.source);
      return app ? resolveCursorAppLinkIdentity(app, request.remoteSessionId) : { ok: false, code: 'source_invalid' };
    }
    const root = await resolveCursorNativeSource(request.source);
    if (!root) return { ok: false, code: 'source_invalid' };
    const file = await findFile(root, request.remoteSessionId, request.signal);
    if (!file) {
      const store = await findCursorCliStore(root.homeDir, request.remoteSessionId, request.signal);
      return store ? ok({ source: root.source, remoteSessionId: store.id, linkData: { cursorSource: CURSOR_CLI_SOURCE } })
        : { ok: false, code: 'candidate_not_found' };
    }
    if (!(await readCursorMetadata(file)).supported) return { ok: false, code: 'unsupported' };
    return ok({ source: root.source, remoteSessionId: file.id, linkData: {} });
  }); },
  resolveLinkedIdentity(request) { return cursorExternalSessionsContribution.resolveLinkIdentity(request); },
  pageTranscript(request) { return run(request, async () => {
    if (request.source.kind === 'cursorApp') {
      const app = await resolveCursorAppStore(request.source);
      return app ? pageCursorAppTranscript(app, request) : { ok: false, code: 'source_invalid' };
    }
    const root = await resolveCursorNativeSource(request.source);
    if (!root) return { ok: false, code: 'source_invalid' };
    // A cursor names its store; a first page uses the JSONL transcript when one exists, else the CLI store.
    if (isCursorCliStoreCursor(request.cursor)) return pageCursorCliStoreTranscript(root.homeDir, request);
    if (request.cursor || await findFile(root, request.remoteSessionId, request.signal)) return page(root, request);
    return pageCursorCliStoreTranscript(root.homeDir, request);
  }); },
  readAfterTranscript(request) { return run<ReadAfterTranscriptValue>(request, async () => {
    if (request.source.kind === 'cursorApp') {
      const app = await resolveCursorAppStore(request.source);
      return app ? readAfterCursorAppTranscript(app, request) : ok({ outcome: 'source_unavailable' as const });
    }
    const root = await resolveCursorNativeSource(request.source);
    if (!root) return ok({ outcome: 'source_unavailable' as const });
    if (isCursorCliStoreCursor(request.cursor)) return readAfterCursorCliStoreTranscript(root.homeDir, request);
    const previous = decodeTranscriptCursor(request.cursor);
    if (!previous || previous.homeDir !== root.homeDir || previous.id !== request.remoteSessionId) return ok({ outcome: 'gap_or_cursor_expired' as const });
    const file = await findFile(root, request.remoteSessionId, request.signal);
    if (!file) return ok({ outcome: 'source_unavailable' as const });
    const info = await lstat(file.path);
    if (info.size < previous.witness.size) return ok({ outcome: 'source_replaced' as const });
    const witness = await cursorFileWitness(file.path, previous.witness.size, request.signal, previous.witness);
    if (!samePrefix(previous.witness, witness)) return ok({ outcome: 'source_replaced' as const });
    if (info.size === previous.position) return ok({ outcome: 'already_current' as const });
    // The prefix is verified above; the existing decoder pages only appended
    // bytes, and returns a new witness bound to the consumed newline frontier.
    const forward = await page(root, { ...request, direction: 'newer' }, { file, prefix: witness });
    if (!forward.ok) return forward.code === 'source_invalid' ? ok({ outcome: 'source_replaced' as const }) : forward;
    if (!forward.value.tailCursor) return ok({ outcome: 'read_failed' as const });
    if (decodeTranscriptCursor(forward.value.tailCursor)?.position === previous.position && !forward.value.items.length) return ok({ outcome: 'already_current' as const });
    return ok({ outcome: 'advanced' as const, items: forward.value.items, nextCursor: forward.value.tailCursor,
      boundary: file.id, hasMore: forward.value.hasMore ?? false, diagnostics: forward.value.diagnostics });
  }); },
};
