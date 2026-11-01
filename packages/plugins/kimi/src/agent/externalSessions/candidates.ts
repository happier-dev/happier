import type { AgentExternalSessionCandidate, AgentExternalSessionsListCandidatesRequest,
  AgentExternalSessionsListCandidatesResult } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionContentSearchControl, ExternalSessionContentSearchYield,
  searchExternalSessionContent } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { decode, encode, fingerprint, KimiStoreError, listKimiSessions, record, type KimiStore } from './source.js';
import { readKimiTranscript } from './wireTranscript.js';

export async function listKimiCandidates(store: KimiStore, request: AgentExternalSessionsListCandidatesRequest): Promise<AgentExternalSessionsListCandidatesResult> {
  const content = request.searchTarget === 'content';
  const query = request.searchTerm ?? '';
  const identity = fingerprint([store.root, content, query, request.searchMode ?? 'fast', request.includeThreads ?? false]);
  const inventory = await listKimiSessions(store, request.signal);
  const generation = fingerprint(inventory.sessions.map(session => [session.id, session.directory]));
  const previous = request.cursor ? decode(request.cursor) : null;
  if (request.cursor && (!previous || previous.v !== 1 || previous.identity !== identity
    || previous.generation !== generation || typeof previous.after !== 'string'
    || typeof previous.partial !== 'boolean' || !Number.isSafeInteger(previous.readable)
    || Number(previous.readable) < 0 || !Number.isSafeInteger(previous.unsupported) || Number(previous.unsupported) < 0)) {
    throw new KimiStoreError('invalid_request');
  }
  let partial = inventory.partial || previous?.partial === true;
  let readable = Number(previous?.readable ?? 0);
  let unsupported = Number(previous?.unsupported ?? 0);
  const candidates: AgentExternalSessionCandidate[] = [];
  const control = createExternalSessionContentSearchControl({ signal: request.signal,
    deadlineAtMs: request.scanDeadlineAtMs ?? request.deadlineAtMs });
  let index = previous ? inventory.sessions.findIndex(session => session.id === previous.after) + 1 : 0;
  if (previous && previous.after !== '' && index === 0) throw new KimiStoreError('source_invalid');
  let after = typeof previous?.after === 'string' ? previous.after : '';
  const cursor = () => encode({ v: 1, identity, generation, after, partial, readable, unsupported });
  const result = (more: boolean): AgentExternalSessionsListCandidatesResult => ({ candidates, nextCursor: more ? cursor() : null,
    ...(partial || unsupported > 0 ? { searchIncomplete: true } : {}),
    ...(content ? { contentCoverage: more || partial || unsupported > 0 && readable > 0 ? 'partial' : unsupported ? 'unsupported' : 'complete' } : {}) });
  const fits = (more: boolean) => Buffer.byteLength(JSON.stringify({ ok: true, value: result(more) })) <= request.maxSerializedBytes;
  while (index < inventory.sessions.length) {
    request.signal.throwIfAborted();
    const session = inventory.sessions[index]!;
    let candidate: AgentExternalSessionCandidate | null = { remoteSessionId: session.id,
      ...(session.title === undefined ? {} : { title: session.title }),
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      ...(session.createdAtMs === undefined ? {} : { createdAtMs: session.createdAtMs }),
      updatedAtMs: session.updatedAtMs, ...(session.archived === undefined ? {} : { archived: session.archived }),
    };
    if (content) {
      try {
        // A later undo/compaction can invalidate an early hit. An interrupted
        // replay publishes nothing and retries this Session from native bytes.
        const projection = await readKimiTranscript(session, request.signal, control);
        const searched = await searchExternalSessionContent({ query, control, isScanComplete: () => true,
          decode: async matchText => ({ partial: projection.partial, records: projection.items.map(item => {
            const data = item.raw.role === 'agent' && record(item.raw.content) && record(item.raw.content.data) ? item.raw.content.data : null;
            const text = item.raw.role === 'user' ? item.raw.content.text
              : data?.type === 'message' && typeof data.message === 'string' ? data.message
              : data?.type === 'tool-result' && typeof data.output === 'string' ? data.output : null;
            const snippet = text === null || projection.partial && text === 'Agent emitted an unsupported content block.' ? null : matchText(text);
            return { id: item.id, ...(snippet === null ? {} : { snippet }) };
          }) }),
        });
        partial ||= searched.partial;
        readable++;
        candidate = searched.match ? { ...candidate, match: searched.match,
          ...(!projection.partial ? { messageCount: projection.items.length } : {}) } : null;
      } catch (error) {
        request.signal.throwIfAborted();
        if (error instanceof KimiStoreError && error.code === 'unsupported') unsupported++;
        else if (error instanceof ExternalSessionContentSearchYield) break;
        else partial = true;
        candidate = null;
      }
    } else if (query && !`${session.id}\n${session.title ?? ''}\n${session.cwd ?? ''}`.toLowerCase().includes(query.toLowerCase())) candidate = null;
    if (candidate) {
      candidates.push(candidate);
      const savedAfter = after;
      after = session.id;
      if (!fits(index + 1 < inventory.sessions.length)) {
        candidates.pop(); after = savedAfter;
        if (!candidates.length) throw new KimiStoreError('agent_error');
        break;
      }
    }
    after = session.id;
    index++;
    if (candidates.length >= request.maxItems) break;
    if (index < inventory.sessions.length) {
      try { control.checkWork(); }
      catch (error) { if (error instanceof ExternalSessionContentSearchYield) break; throw error; }
    }
  }
  const value = result(index < inventory.sessions.length);
  if (!fits(index < inventory.sessions.length)) throw new KimiStoreError('agent_error');
  return value;
}
