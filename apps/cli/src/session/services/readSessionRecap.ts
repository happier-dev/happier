import { SessionSynopsisV1Schema } from '@happier-dev/protocol/messages/structured/sessionSynopsisV1';
import { TranscriptRawRecordV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { readSessionMemoryEnabledV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { resolveSessionRecap, resolveSessionRecapState, type SessionRecapState, type SessionRecapWorkerUpdate } from '@happier-dev/protocol/sessions/awareness/action';
import { SESSION_SYSTEM_RECORD_LIST_LIMIT_MAX } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { SESSION_TRANSCRIPT_GET_MAX_LIMIT } from '@happier-dev/protocol/actions/actionSpecs';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import type { RawSessionListRow } from '@/session/transport/http/sessionsHttp';
import { readSessionPresentationContent, resolveExactSessionOrCredentialCryptoContext, openSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';
import { listSessionSystemRecordsV1 } from '@/session/transport/http/sessionSystemRecordsHttp';
import { MEMORY_SYSTEM_RECORD_KINDS, MEMORY_SYSTEM_RECORD_NAMESPACE, openMemorySystemRecordPayload } from '@/session/systemRecords/memory/memorySystemRecords';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';

/** Authenticated exact-Session readers only; no arbitrary record address is caller-controlled. */
export async function readSessionRecap(params: Readonly<{
  credentials: StoredCredentials; row: RawSessionListRow; currentness: AccountEncryptionCurrentnessResponse;
  resolveAuthorizationHeaders: (request: Readonly<{ method: 'GET'; path: string }>) => Readonly<Record<string, string>> | null;
  signal?: AbortSignal;
}>): Promise<SessionRecapState> {
  const unavailable = { status: 'unavailable', recap: null } as const;
  const presentation = readSessionPresentationContent({ credentials: params.credentials,
    accountEncryptionMode: params.currentness.mode, recipientEnvelopeReadiness: params.currentness.recipientEnvelopeReadiness,
    rawSession: params.row });
  const crypto = resolveExactSessionOrCredentialCryptoContext(params, params.row.id, params.row);
  if (!presentation.metadata || !crypto) return unavailable;
  const memoryEnabled = readSessionMemoryEnabledV1(presentation.metadata);
  const synopses: Array<{ synopsis: string; seqTo: number; updatedAtMs: number }> = [];
  try {
    if (memoryEnabled) {
      let cursor: string | null = null;
      do {
        params.signal?.throwIfAborted();
        const page = await listSessionSystemRecordsV1({ token: params.credentials.token, sessionId: params.row.id,
          query: { owner: 'host', namespace: MEMORY_SYSTEM_RECORD_NAMESPACE, kind: MEMORY_SYSTEM_RECORD_KINDS.synopsis,
            limit: SESSION_SYSTEM_RECORD_LIST_LIMIT_MAX, cursor },
          resolveAuthorizationHeaders: params.resolveAuthorizationHeaders, signal: params.signal });
        for (const record of page.records) {
          const payload = openMemorySystemRecordPayload({ mode: crypto.mode, ...(crypto.mode === 'e2ee' ? { ctx: crypto.ctx } : {}), namespace: MEMORY_SYSTEM_RECORD_NAMESPACE,
            kind: MEMORY_SYSTEM_RECORD_KINDS.synopsis, content: record.content });
          const synopsis = SessionSynopsisV1Schema.safeParse(payload);
          if (!synopsis.success) return unavailable;
          synopses.push(synopsis.data);
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      const recap = resolveSessionRecap({ memoryEnabled, synopses, latestWorkerUpdate: null });
      if (recap) return { status: 'ready', recap };
    }
    // Walk the existing event-only transcript page owner backwards. Ordinary streamed text
    // is not fetched/decrypted; stop as soon as the most recent delivered WorkerUpdate is found.
    let beforeSeq: number | undefined;
    let latestWorkerUpdate: SessionRecapWorkerUpdate | null = null;
    do {
      params.signal?.throwIfAborted();
      const page = await fetchEncryptedTranscriptMessagesPage({ token: params.credentials.token, sessionId: params.row.id,
        roles: ['event'], scope: 'main', limit: SESSION_TRANSCRIPT_GET_MAX_LIMIT, beforeSeq,
        resolveAuthorizationHeaders: params.resolveAuthorizationHeaders, signal: params.signal });
      if (page.publicationBlocked) return unavailable;
      let latestSeq = -1;
      for (const row of page.messages) {
        const opened = TranscriptRawRecordV1Schema.safeParse(openSessionStoredContent({ ...crypto, content: row.content }));
        if (!opened.success) return unavailable;
        const raw = opened.data;
        if (raw.role !== 'agent' || raw.content.type !== 'event' || raw.content.data.type !== 'worker-update') continue;
        const update = raw.content.data.update;
        const seq = typeof row.seq === 'number' ? row.seq : 0;
        if (seq < latestSeq) continue;
        latestSeq = seq;
        latestWorkerUpdate = { headline: update.headline, body: update.result, atMs: typeof row.createdAt === 'number' ? row.createdAt : 0,
          workerSessionId: update.workerKind === 'session' ? update.workerId : null };
      }
      if (latestWorkerUpdate || !page.hasMore) break;
      if (page.nextBeforeSeq === null || page.nextBeforeSeq === beforeSeq) return unavailable;
      beforeSeq = page.nextBeforeSeq;
    } while (true);
    return resolveSessionRecapState({ memoryEnabled, synopses, latestWorkerUpdate, contentReadable: true, transcriptLoaded: true });
  } catch (error) {
    if (params.signal?.aborted) throw error;
    return unavailable;
  }
}
