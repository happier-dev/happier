import { createHash } from 'node:crypto';
import { isRecord, parseTimestampMs } from '@happier-dev/plugin-sdk';
import { getAgentExternalSessionsInvocationFailure, isAgentExternalSessionsResultWithinByteBudget,
  createAgentExternalSessionsProducerOverflowFailure,
  type AgentExternalSessionAccountingObservation, type AgentExternalSessionsReadAccountingRequest,
  type AgentExternalSessionsReadAccountingResult, type AgentExternalSessionsResult,
} from '@happier-dev/plugin-sdk/sessions/external';
import { createOpenCodeExternalSessionClient, type OpenCodeExternalSessionSource,
  type OpenCodeExternalSessionListCursor } from '../surfaces/sessions/external/client.js';
import type { OpenCodeServerDialect } from '../runtime/server/dialect.js';
import { readNonBlankOpaqueIdentifier } from '../runtime/server/openCodeParsing.js';
import { normalizeOpenCodePaidUsage } from './paidUsage.js';

const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

type Frontier = { updated: number | null; facts: Record<string, string> };
type Cursor = { v: 1; source: string; sessions: Record<string, Frontier>; incomplete: boolean };
function decode(raw: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (!isRecord(value) || value.v !== 1 || typeof value.source !== 'string' || !isRecord(value.sessions) || typeof value.incomplete !== 'boolean') return null;
    const sessions: Record<string, Frontier> = {};
    for (const [id, entry] of Object.entries(value.sessions)) {
      if (!isRecord(entry) || !isRecord(entry.facts) || !(entry.updated === null || number(entry.updated) !== null)
        || !Object.values(entry.facts).every((fact) => typeof fact === 'string')) return null;
      sessions[id] = { updated: entry.updated as number | null, facts: entry.facts as Record<string, string> };
    }
    return { v: 1, source: value.source, sessions, incomplete: value.incomplete };
  } catch { return null; }
}

export async function readOpenCodeNativeAccounting(request: AgentExternalSessionsReadAccountingRequest,
  source: OpenCodeExternalSessionSource, dialect: OpenCodeServerDialect): Promise<AgentExternalSessionsResult<AgentExternalSessionsReadAccountingResult>> {
  const ok = (value: AgentExternalSessionsReadAccountingResult): AgentExternalSessionsResult<AgentExternalSessionsReadAccountingResult> => ({ ok: true, value });
  const identity = hash(JSON.stringify(source));
  const previous = request.cursor ? decode(request.cursor) : null;
  if (request.cursor && (!previous || previous.source !== identity)) return ok({ outcome: 'gap_or_cursor_expired' });
  const changedSessionIds = previous && request.changedNativeSessionIds !== undefined
    ? [...new Set(request.changedNativeSessionIds)] : undefined;
  if (changedSessionIds?.length === 0) return getAgentExternalSessionsInvocationFailure(request) ?? ok({ outcome: 'unchanged' });
  const cursor: Cursor = { v: 1, source: identity, sessions: { ...previous?.sessions }, incomplete: previous?.incomplete ?? false };
  const observations: AgentExternalSessionAccountingObservation[] = [];
  const client = await createOpenCodeExternalSessionClient({ source, dialect, managedEndpointRead: request.managedEndpointRead });
  let changed = !previous;
  try {
    let listCursor: OpenCodeExternalSessionListCursor | undefined;
    const seen = new Set<string>(); const pageCursors = new Set<string>();
    do {
      const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
      // Event evidence survives all the way from the shared observer. A late
      // message settlement rereads its Session even if time.updated is equal.
      // Directory-scoped listings are the native authority for membership
      // (the stored directory may differ from a configured path alias).
      const listSessions = changedSessionIds === undefined || Boolean(source.directory);
      const page = listSessions
        ? await client.sessionList({ signal: request.signal, ...(listCursor ? { cursor: listCursor } : {}) })
        : { items: await Promise.all(changedSessionIds.map(sessionId => client.sessionGet({ sessionId, signal: request.signal }))), nextCursor: null };
      for (const raw of page.items) {
        if (!isRecord(raw)) { if (changedSessionIds) return ok({ outcome: 'read_failed' }); cursor.incomplete = true; continue; }
        const id = readNonBlankOpaqueIdentifier(raw.id); if (!id) { if (changedSessionIds) return ok({ outcome: 'read_failed' }); cursor.incomplete = true; continue; }
        if (changedSessionIds && !changedSessionIds.includes(id)) {
          if (!listSessions) return ok({ outcome: 'read_failed' });
          continue;
        }
        seen.add(id);
        const updated = isRecord(raw.time) ? number(raw.time.updated) : null;
        const old = previous?.sessions[id];
        // Native message accounting can settle without changing Session.time.updated.
        // Message IDs, not the Session timestamp, own the accounting frontier.
        if (!old || old.updated !== updated) changed = true;
        const facts = { ...old?.facts }; let before: string | undefined; const messageCursors = new Set<string>();
        do {
          const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
          const messages = await client.sessionMessagesList({ sessionId: id, signal: request.signal, ...(before ? { before } : {}) });
          for (const message of messages.items) {
            const info = isRecord(message) && isRecord(message.info) ? message.info : null;
            if (!info || info.role !== 'assistant') continue;
            const inferenceId = readNonBlankOpaqueIdentifier(info.id);
            const usage = normalizeOpenCodePaidUsage(info, dialect);
            if (!usage) { cursor.incomplete = true; continue; }
            const time = isRecord(info.time) ? info.time : {};
            const observedAt = parseTimestampMs(time.completed ?? time.created);
            if (!inferenceId || observedAt === null) { cursor.incomplete = true; continue; }
            const observation: AgentExternalSessionAccountingObservation = { nativeSessionId: id, inferenceId, observedAt,
              ...(typeof raw.directory === 'string' && raw.directory.length > 0 ? { project: { rootPath: raw.directory } } : {}),
              accounting: { inputIncludesCache: usage.inputIncludesCache, outputIncludesReasoning: usage.outputIncludesReasoning },
              ...(typeof raw.parentID === 'string' ? { parentNativeSessionId: raw.parentID } : {}),
              observation: { provider: 'opencode', source: 'opencode-native-accounting', scope: 'turn_delta', key: inferenceId,
                modelId: typeof info.modelID === 'string' ? info.modelID : null,
                tokens: usage.tokens, cost: usage.cost, contextUsedTokens: null, contextWindowTokens: null } };
            const fingerprint = hash(JSON.stringify(observation));
            if (facts[inferenceId] !== fingerprint) { observations.push(observation); changed = true; }
            facts[inferenceId] = fingerprint;
          }
          if (!messages.nextCursor) break;
          if (messageCursors.has(messages.nextCursor)) return ok({ outcome: 'read_failed' });
          messageCursors.add(messages.nextCursor); before = messages.nextCursor;
        } while (true);
        cursor.sessions[id] = { updated, facts };
      }
      if (!page.nextCursor) break;
      if (pageCursors.has(page.nextCursor)) return ok({ outcome: 'read_failed' });
      pageCursors.add(page.nextCursor);
      if (dialect === 'v2') listCursor = { kind: 'sourceToken', token: page.nextCursor };
      else { const updatedAtMs = Number(page.nextCursor); if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) return ok({ outcome: 'read_failed' });
        listCursor = { kind: 'updatedAtMs', updatedAtMs }; }
    } while (true);
    if (changedSessionIds === undefined && previous && Object.keys(previous.sessions).some((id) => !seen.has(id))) return ok({ outcome: 'source_replaced' });
    if (!changed && cursor.incomplete === previous?.incomplete) return ok({ outcome: 'unchanged' });
    const result = ok({ outcome: 'advanced', observations, nextCursor: Buffer.from(JSON.stringify(cursor)).toString('base64url'),
      coverage: { complete: false, reason: cursor.incomplete ? 'native_accounting_unavailable' : 'native_fork_lineage_unavailable' } });
    return isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes) ? result
      : createAgentExternalSessionsProducerOverflowFailure('OpenCode accounting exceeds the invocation byte bound.');
  } catch { return getAgentExternalSessionsInvocationFailure(request) ?? ok({ outcome: 'read_failed' }); }
  finally { await client.dispose(); }
}
