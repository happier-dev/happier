import { isRecord } from '@happier-dev/plugin-sdk';
import type { AgentExternalSessionCandidate, AgentExternalSessionTranscriptItem, AgentExternalSessionsListCandidatesRequest, AgentExternalSessionsListCandidatesResult, AgentExternalSessionsResult } from '@happier-dev/plugin-sdk/sessions/external';
import { isAgentExternalSessionsResultWithinByteBudget, projectExternalSessionCandidateTitle, readSessionInputPromptUserTextV1 } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionContentSearchControl, ExternalSessionContentSearchYield, searchExternalSessionContent,
  type ExternalSessionContentSearchPageProgress } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { listQwenFiles, QwenSourceError, type QwenSource } from './source.js';
import { digestItems, readQwenTranscript } from './transcript.js';

export function encode(value: unknown): string { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }
export function decode(value: string): Record<string, unknown> {
  try { const record: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); if (isRecord(record)) return record; } catch { /* Invalid public cursor. */ }
  throw new QwenSourceError('invalid_request', 'Qwen cursor is invalid.');
}
export function visibleText(item: AgentExternalSessionTranscriptItem): string | null {
  if (item.raw.role === 'user') return item.raw.content.text;
  const content = item.raw.content;
  const data = isRecord(content) && isRecord(content.data) ? content.data : null;
  if (data?.type === 'message' && typeof data.message === 'string') return data.message;
  return data?.type === 'tool-result' && typeof data.output === 'string' ? data.output : null;
}
function promptTitle(text: string): string {
  // Pinned SessionService.truncatePromptForDisplay uses 200 Unicode code
  // points for native list previews. This never bounds searchable body text.
  const title = projectExternalSessionCandidateTitle(readSessionInputPromptUserTextV1(text), { source: 'prompt' });
  const points = [...title]; return points.length > 200 ? points.slice(0, 200).join('') + '...' : title;
}
type Scan = { v: 1; source: string; query: string; target: string; threads: boolean; after: string;
  partial: boolean; pending?: { path: string; digest: string; progress: ExternalSessionContentSearchPageProgress } };
function readScan(raw: string, base: Pick<Scan, 'source' | 'query' | 'target' | 'threads'>): Scan {
  const value = decode(raw);
  if (value.v !== 1 || value.source !== base.source || value.query !== base.query || value.target !== base.target || value.threads !== base.threads
    || typeof value.after !== 'string' || typeof value.partial !== 'boolean') throw new QwenSourceError('invalid_request', 'Qwen search cursor does not match its request.');
  const scan: Scan = { v: 1, ...base, after: value.after, partial: value.partial };
  if (value.pending !== undefined) {
    const pending = value.pending;
    if (!isRecord(pending) || typeof pending.path !== 'string' || typeof pending.digest !== 'string' || !isRecord(pending.progress))
      throw new QwenSourceError('invalid_request', 'Qwen search progress is invalid.');
    const progress = pending.progress;
    if (typeof progress.complete !== 'boolean' || !Number.isSafeInteger(progress.itemCount) || Number(progress.itemCount) < 0
      || (progress.cursor !== undefined && (typeof progress.cursor !== 'string' || !/^\d+$/.test(progress.cursor))))
      throw new QwenSourceError('invalid_request', 'Qwen search progress is invalid.');
    let match: ExternalSessionContentSearchPageProgress['match'] = null;
    if (progress.match !== null) {
      const found = progress.match;
      if (!isRecord(found) || typeof found.id !== 'string' || !Number.isSafeInteger(found.distanceFromEnd) || Number(found.distanceFromEnd) < 1
        || Number(found.distanceFromEnd) > Number(progress.itemCount)
        || (found.cursor !== undefined && (typeof found.cursor !== 'string' || !/^\d+$/.test(found.cursor))))
        throw new QwenSourceError('invalid_request', 'Qwen search match locator is invalid.');
      match = { id: found.id, distanceFromEnd: Number(found.distanceFromEnd), ...(typeof found.cursor === 'string' ? { cursor: found.cursor } : {}) };
    }
    scan.pending = { path: pending.path, digest: pending.digest, progress: { complete: progress.complete, itemCount: Number(progress.itemCount), match,
      ...(typeof progress.cursor === 'string' ? { cursor: progress.cursor } : {}) } };
  }
  return scan;
}

export async function listQwenCandidates(source: QwenSource, request: AgentExternalSessionsListCandidatesRequest): Promise<AgentExternalSessionsListCandidatesResult> {
  const base = { source: source.runtimeDir, query: request.searchTerm ?? '', target: request.searchTarget ?? 'metadata', threads: request.includeThreads === true };
  const scan: Scan = request.cursor ? readScan(request.cursor, base) : { v: 1, ...base, after: '', partial: false };
  // Stable native path ordering leaves appends in unrelated sessions independent
  // from an in-flight continuation. UI's shared owner merges hits by recency.
  const files = [...await listQwenFiles(source, request.signal)].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  const candidates: AgentExternalSessionCandidate[] = [];
  const control = createExternalSessionContentSearchControl({ signal: request.signal, deadlineAtMs: request.scanDeadlineAtMs ?? request.deadlineAtMs });
  let nextCursor: string | null = null;
  for (const file of files) {
    if (scan.pending ? file.relativePath < scan.pending.path : file.relativePath <= scan.after) continue;
    request.signal.throwIfAborted();
    let transcript;
    try { transcript = await readQwenTranscript(file, request.signal); }
    catch (error) {
      if (!(error instanceof QwenSourceError) || error.code !== 'unsupported') throw error;
      scan.partial = true; scan.after = file.relativePath; delete scan.pending; continue;
    }
    scan.partial ||= transcript.partial;
    if (transcript.parentSessionId && !base.threads) { scan.after = file.relativePath; continue; }
    const firstUser = transcript.items.find(item => item.raw.role === 'user');
    const title = transcript.title ?? (firstUser ? promptTitle(visibleText(firstUser) ?? '') || undefined : undefined);
    let candidate: AgentExternalSessionCandidate = { remoteSessionId: file.sessionId, updatedAtMs: file.updatedAtMs, createdAtMs: transcript.createdAtMs,
      archived: file.archived, ...(title ? { title } : {}), ...(transcript.cwd ? { cwd: transcript.cwd } : {}),
      ...(!transcript.partial ? { messageCount: transcript.items.length } : {}),
      ...(transcript.parentSessionId ? { thread: { kind: 'subagent' as const, parentRemoteSessionId: transcript.parentSessionId } } : {}) };
    if (base.target === 'content') {
      const digest = digestItems(transcript.items);
      if (scan.pending && (scan.pending.path !== file.relativePath || scan.pending.digest !== digest))
        throw new QwenSourceError('source_invalid', 'Qwen transcript changed during content search.');
      const progress = scan.pending?.progress ?? { complete: false, itemCount: 0, match: null };
      scan.pending = { path: file.relativePath, digest, progress };
      try {
        const result = await searchExternalSessionContent({ query: base.query, control, pageProgress: progress,
          // Active-history replay already decoded this file. A raw-text
          // prefilter cannot exclude phrases spanning parts or UUID fragments.
          decode: async (matchText, cursor) => {
            const end = cursor === undefined ? transcript.items.length : Number(cursor);
            if (!Number.isSafeInteger(end) || end < 0 || end > transcript.items.length) throw new QwenSourceError('invalid_request', 'Qwen content position is invalid.');
            if (!end) return { records: [], partial: false };
            const item = transcript.items[end - 1]!; const text = visibleText(item); const snippet = text === null ? null : matchText(text);
            return { records: [{ id: item.id, ...(snippet === null ? {} : { snippet }) }], partial: false, nextCursor: end > 1 ? String(end - 1) : null };
          } });
        if (!result.match) { scan.after = file.relativePath; delete scan.pending; continue; }
        candidate = { ...candidate, match: result.match };
      } catch (error) {
        if (!(error instanceof ExternalSessionContentSearchYield)) throw error;
        nextCursor = encode(scan); break;
      }
    } else if (base.query && !`${title ?? ''}\n${transcript.cwd ?? ''}\n${file.sessionId}`.toLowerCase().includes(base.query.toLowerCase())) {
      scan.after = file.relativePath; continue;
    }
    const proposed: AgentExternalSessionsResult<unknown> = { ok: true, value: { candidates: [...candidates, candidate], nextCursor: encode(scan) } };
    if (!isAgentExternalSessionsResultWithinByteBudget(proposed, request.maxSerializedBytes)) {
      if (!candidates.length) throw new QwenSourceError('agent_error', 'Qwen candidate exceeds the caller result budget.');
      nextCursor = encode(scan); break;
    }
    candidates.push(candidate); scan.after = file.relativePath; delete scan.pending;
    if (candidates.length >= request.maxItems) { if (files.some(next => next.relativePath > scan.after)) nextCursor = encode(scan); break; }
  }
  return { candidates, nextCursor, ...(base.target === 'content' ? { contentCoverage: scan.partial || nextCursor ? 'partial' : 'complete' } : {}),
    ...(scan.partial || nextCursor ? { searchIncomplete: true } : {}) };
}
