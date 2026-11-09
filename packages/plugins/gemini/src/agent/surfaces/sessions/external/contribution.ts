import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isRecord } from '@happier-dev/plugin-sdk';
import type {
  AgentExternalSessionCandidate, AgentExternalSessionSource,
  AgentExternalSessionsContribution, AgentExternalSessionsFailureCode, AgentExternalSessionsInvocation,
  AgentExternalSessionsResult, AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';
import { createAgentExternalSessionsProducerOverflowFailure, getAgentExternalSessionsInvocationFailure,
  isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionContentSearchControl, discoverAgentAccountingJsonlSource,
  ExternalSessionContentSearchYield, searchExternalSessionContent } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { geminiChatSessionFileNameMatchesSessionId, listGeminiChatSessionFiles, readGeminiProjectsMap } from '../../../connectedServices/chatSessionFiles.js';
import { resolveGeminiSource } from './source.js';
import { geminiItemText, readGeminiTranscript, UnsupportedGeminiTranscript } from './transcript.js';

const ok = <T>(value: T): AgentExternalSessionsResult<T> => ({ ok: true, value });
const fail = (code: AgentExternalSessionsFailureCode): AgentExternalSessionsResult<never> => ({ ok: false, code });
class GeminiCandidateNotFound extends Error {}
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(cursor: string): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString()); return isRecord(value) ? value : null; }
  catch { return null; }
}
function bounded<T>(value: T, request: AgentExternalSessionsInvocation): AgentExternalSessionsResult<T> {
  const result = ok(value);
  return isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes)
    ? result : createAgentExternalSessionsProducerOverflowFailure('Gemini native result exceeds the caller byte budget.');
}
function failure(error: unknown, request: AgentExternalSessionsInvocation): AgentExternalSessionsResult<never> {
  return getAgentExternalSessionsInvocationFailure(request) ?? fail(error instanceof UnsupportedGeminiTranscript ? 'unsupported'
    : error instanceof GeminiCandidateNotFound ? 'candidate_not_found' : 'source_unreachable');
}
type TranscriptCursor = Readonly<{ v: 1; kind: 'geminiTranscript'; source: string; sessionId: string;
  generation: string; count: number; digest: string; end: number }>;
function cursorFor(source: AgentExternalSessionSource, transcript: Awaited<ReturnType<typeof readGeminiTranscript>>,
  generation: string, end = transcript.items.length): TranscriptCursor {
  return { v: 1, kind: 'geminiTranscript', source: hash(JSON.stringify(source)), sessionId: transcript.sessionId,
    generation, count: transcript.items.length, digest: hash(JSON.stringify(transcript.items)), end };
}
function readCursor(raw: string, source: AgentExternalSessionSource, sessionId: string): TranscriptCursor | null {
  const cursor = decode(raw);
  if (!cursor || cursor.v !== 1 || cursor.kind !== 'geminiTranscript' || cursor.source !== hash(JSON.stringify(source))
    || cursor.sessionId !== sessionId || typeof cursor.generation !== 'string' || typeof cursor.digest !== 'string'
    || typeof cursor.count !== 'number' || !Number.isSafeInteger(cursor.count) || cursor.count < 0
    || typeof cursor.end !== 'number' || !Number.isSafeInteger(cursor.end) || cursor.end < 0 || cursor.end > cursor.count) return null;
  return { v: 1, kind: 'geminiTranscript', source: cursor.source as string, sessionId,
    generation: cursor.generation, count: cursor.count, digest: cursor.digest, end: cursor.end };
}
async function load(source: AgentExternalSessionSource, remoteSessionId: string, signal: AbortSignal) {
  const resolved = await resolveGeminiSource(source);
  const files = await listGeminiChatSessionFiles(resolved.configDir, signal);
  let unknownIdentity = false;
  // Short native IDs occur in filenames; verify the complete native session ID
  // in the decoder before granting an identity or reading a persisted cursor.
  const preferred = files.filter(file => geminiChatSessionFileNameMatchesSessionId(basename(file.filePath), remoteSessionId));
  const preferredPaths = new Set(preferred.map(file => file.filePath));
  for (const file of [...preferred, ...files.filter(file => !preferredPaths.has(file.filePath))]) {
    const transcript = await readGeminiTranscript(file.filePath, signal).catch(error => {
      if (error instanceof UnsupportedGeminiTranscript && error.sessionId !== remoteSessionId) {
        unknownIdentity ||= error.sessionId === undefined;
        return null;
      }
      throw error;
    });
    if (transcript?.sessionId !== remoteSessionId) continue;
    const info = await stat(file.filePath);
    return { source: resolved, transcript, filePath: file.filePath, generation: `${info.dev}:${info.ino}:${info.birthtimeMs}` };
  }
  if (unknownIdentity) throw new UnsupportedGeminiTranscript('Gemini history contains an unreadable native identity');
  throw new GeminiCandidateNotFound('Gemini native identity is absent from the readable history root');
}
function prefixMatches(cursor: TranscriptCursor, transcript: Awaited<ReturnType<typeof readGeminiTranscript>>, generation: string) {
  return cursor.generation === generation && transcript.items.length >= cursor.count
    && hash(JSON.stringify(transcript.items.slice(0, cursor.count))) === cursor.digest;
}

export const geminiExternalSessionsContribution: AgentExternalSessionsContribution = {
  async resolveSource(request) {
    const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
    try {
      const source = await resolveGeminiSource(request.source);
      if (request.includeAccountingSource === false) return ok({ source });
      const rootPath = join(source.configDir, 'tmp');
      const inventory = await discoverAgentAccountingJsonlSource([rootPath], request.signal);
      const native = await listGeminiChatSessionFiles(source.configDir, request.signal);
      return ok({ source, accountingSource: { rootPath: source.configDir, rootField: 'configDir', resourceKey: `gemini:transcripts:${hash(source.configDir)}`,
        changeObservation: 'watch_file_changes', watchFileChanges: {
          files: [...new Set([...native.map(file => file.filePath), join(source.configDir, 'projects.json')])],
          topologyDirectories: [...new Set([...inventory.topologyDirectories, source.configDir])],
        } } });
    } catch (error) { return failure(error, request); }
  },
  async listCandidates(request) {
    const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
    if (!Number.isSafeInteger(request.maxItems) || request.maxItems < 1) return fail('invalid_request');
    try {
      const source = await resolveGeminiSource(request.source);
      const sourceKey = hash(JSON.stringify(source));
      const query = request.searchTerm ?? '';
      const content = request.searchTarget === 'content';
      const threads = request.includeThreads === true;
      const cursor = request.cursor ? decode(request.cursor) : null;
      if (request.cursor && (!cursor || cursor.v !== 1 || cursor.kind !== 'geminiCandidates' || cursor.source !== sourceKey
        || cursor.query !== query || cursor.content !== content || cursor.threads !== threads || typeof cursor.after !== 'string'
        || typeof cursor.partial !== 'boolean')) return fail('invalid_request');
      const inventory = await listGeminiChatSessionFiles(source.configDir, request.signal);
      const files = inventory.filter(file => !cursor || file.filePath > String(cursor.after));
      const projects = await readGeminiProjectsMap(source.configDir);
      const candidates: AgentExternalSessionCandidate[] = [];
      const control = createExternalSessionContentSearchControl({ signal: request.signal,
        deadlineAtMs: request.scanDeadlineAtMs ?? request.deadlineAtMs });
      let partial = cursor?.partial === true;
      let after = typeof cursor?.after === 'string' ? cursor.after : '';
      const page = (nextCursor: string | null) => ({ candidates, nextCursor,
        ...(content ? { contentCoverage: partial || nextCursor ? 'partial' as const : 'complete' as const } : {}),
        ...(partial ? { searchIncomplete: true } : {}) });
      const next = () => encode({ v: 1, kind: 'geminiCandidates', source: sourceKey, query, content, threads, after, partial });
      for (let index = 0; index < files.length; index++) {
        request.signal.throwIfAborted();
        const file = files[index]!;
        let transcript: Awaited<ReturnType<typeof readGeminiTranscript>>;
        try { transcript = await readGeminiTranscript(file.filePath, request.signal, control); }
        catch (error) {
          request.signal.throwIfAborted();
          if (error instanceof ExternalSessionContentSearchYield) return bounded(page(next()), request);
          if (!(error instanceof UnsupportedGeminiTranscript)) throw error;
          partial = true; after = file.filePath; continue;
        }
        if (transcript.subagent && !request.includeThreads) { after = file.filePath; continue; }
        partial ||= transcript.partial;
        const cwd = Object.entries(projects).find(([, slug]) => slug === file.projectSlug)?.[0];
        let candidate: AgentExternalSessionCandidate | null = { remoteSessionId: transcript.sessionId,
          ...(transcript.title ? { title: transcript.title } : {}), ...(cwd ? { cwd } : {}),
          updatedAtMs: transcript.updatedAtMs, createdAtMs: transcript.createdAtMs,
          ...(!transcript.partial ? { messageCount: transcript.items.length } : {}),
          ...(transcript.subagent ? { thread: { kind: 'subagent', parentRemoteSessionId: null } as const } : {}) };
        if (content) {
          // Replay already read the native file. Raw JSON cannot safely
          // prefilter text joined across native parts or patch fragments.
          const result = await searchExternalSessionContent({ query, control,
            isScanComplete: () => true,
            decode: async match => ({ records: transcript.items.map(item => {
              const text = geminiItemText(item); const snippet = text === null ? null : match(text);
              return { id: item.id, ...(snippet === null ? {} : { snippet }) };
            }), partial: transcript.partial }),
          });
          candidate = result.match ? { ...candidate, match: result.match } : null;
        } else if (query && ![candidate.title, candidate.cwd, candidate.remoteSessionId].some(value => value?.toLowerCase().includes(query.toLowerCase()))) candidate = null;
        if (candidate) {
          candidates.push(candidate);
          if (!isAgentExternalSessionsResultWithinByteBudget(ok(page(index + 1 < files.length ? next() : null)), request.maxSerializedBytes)) {
            candidates.pop();
            if (!candidates.length) return createAgentExternalSessionsProducerOverflowFailure('Gemini candidate exceeds the caller byte budget.');
            return bounded(page(next()), request);
          }
        }
        after = file.filePath;
        if (index + 1 < files.length) {
          if (candidates.length >= request.maxItems) return bounded(page(next()), request);
          try { control.checkWork(); } catch (error) {
            if (!(error instanceof ExternalSessionContentSearchYield)) throw error;
            return bounded(page(next()), request);
          }
        }
      }
      return bounded(page(null), request);
    } catch (error) { return failure(error, request); }
  },
  async resolveLinkIdentity(request) {
    try { const value = await load(request.source, request.remoteSessionId, request.signal);
      return ok({ source: value.source, remoteSessionId: value.transcript.sessionId, linkData: {} });
    } catch (error) { return failure(error, request); }
  },
  async resolveLinkedIdentity(request) { return geminiExternalSessionsContribution.resolveLinkIdentity(request); },
  async pageTranscript(request) {
    const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
    if (!Number.isSafeInteger(request.maxItems) || request.maxItems < 1) return fail('invalid_request');
    try {
      const value = await load(request.source, request.remoteSessionId, request.signal);
      const cursor = request.cursor ? readCursor(request.cursor, value.source, request.remoteSessionId) : null;
      if (request.cursor && !cursor) return fail('invalid_request');
      if (cursor && !prefixMatches(cursor, value.transcript, value.generation)) return fail('source_invalid');
      const older = request.direction === 'older';
      let end = older ? cursor?.end ?? value.transcript.items.length
        : Math.min(value.transcript.items.length, (cursor?.end ?? 0) + request.maxItems);
      let start = older ? Math.max(0, end - request.maxItems) : cursor?.end ?? 0;
      const tail = () => ({ ...cursorFor(value.source, value.transcript, value.generation), count: older ? value.transcript.items.length : end,
        end: older ? value.transcript.items.length : end, digest: hash(JSON.stringify(value.transcript.items.slice(0, older ? value.transcript.items.length : end))) });
      const build = (): AgentExternalSessionsTranscriptPage => ({ items: value.transcript.items.slice(start, end),
        nextCursor: (older ? start > 0 : end < value.transcript.items.length)
          ? encode({ ...cursorFor(value.source, value.transcript, value.generation), end: older ? start : end }) : null,
        tailCursor: encode(tail()), hasMore: older ? start > 0 : end < value.transcript.items.length,
        ...(value.transcript.partial ? { truncated: true } : {}) });
      const hadItems = start < end;
      while (!isAgentExternalSessionsResultWithinByteBudget(ok(build()), request.maxSerializedBytes) && start < end) {
        if (older) start++; else end--;
      }
      if (start === end && hadItems) return createAgentExternalSessionsProducerOverflowFailure('Gemini message exceeds the caller byte budget.');
      return bounded(build(), request);
    } catch (error) { return failure(error, request); }
  },
  async readAfterTranscript(request) {
    const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
    if (!Number.isSafeInteger(request.maxItems) || request.maxItems < 1) return fail('invalid_request');
    try {
      const value = await load(request.source, request.remoteSessionId, request.signal);
      const cursor = readCursor(request.cursor, value.source, request.remoteSessionId);
      if (!cursor) return ok({ outcome: 'gap_or_cursor_expired' });
      if (!prefixMatches(cursor, value.transcript, value.generation)) return ok({ outcome: 'source_replaced' });
      if (cursor.count === value.transcript.items.length) return ok(value.transcript.partial ? { outcome: 'read_failed' } : { outcome: 'already_current' });
      let end = Math.min(value.transcript.items.length, cursor.count + request.maxItems);
      const build = () => {
        const prefix = value.transcript.items.slice(0, end);
        const nextCursor = encode({ ...cursorFor(value.source, value.transcript, value.generation),
          count: end, end, digest: hash(JSON.stringify(prefix)) });
        return { outcome: 'advanced' as const, items: value.transcript.items.slice(cursor.count, end), nextCursor,
          boundary: nextCursor, hasMore: end < value.transcript.items.length };
      };
      while (!isAgentExternalSessionsResultWithinByteBudget(ok(build()), request.maxSerializedBytes) && end > cursor.count) end--;
      if (end === cursor.count) return createAgentExternalSessionsProducerOverflowFailure('Gemini appended message exceeds the caller byte budget.');
      return bounded(build(), request);
    } catch (error) {
      if (error instanceof GeminiCandidateNotFound) return ok({ outcome: 'source_unavailable' });
      return failure(error, request);
    }
  },
};
