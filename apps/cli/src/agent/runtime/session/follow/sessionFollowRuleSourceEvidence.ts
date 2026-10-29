import type { SessionAwarenessOriginV1, SessionAwarenessProjectionV1 } from '@happier-dev/protocol';
import { readOpenedSessionFollowOriginalV1, readSessionFollowSemanticSourceEventV1 as readSessionFollowSemanticSourceEvent,
  captureSemanticSessionFollowRuleSourceEvidenceV1 as captureSemanticSessionFollowRuleSourceEvidence,
  type SessionFollowOriginalOccurrenceV1, type SessionFollowOriginalReadV1,
  type SessionFollowRuleSourceEvidenceV1, type SessionFollowRuleSourceOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { RawTranscriptRow } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { openSessionStoredContent, type SessionStoredContentEncryptionMode, type SessionEncryptionContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { SessionMessageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { resolveSessionFollowTurnEventV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import axios from '@/api/client/credentialAxios';
import type { StoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { SessionFollowObserveSourceRoutesRequestV1Schema, SessionFollowObserveSourceRoutesResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
export { readSessionFollowSemanticSourceEvent, captureSemanticSessionFollowRuleSourceEvidence };
export type SessionFollowAccountOccurrence = SessionFollowOriginalOccurrenceV1;
export type CommittedSessionFollowSourceOccurrenceRead = SessionFollowOriginalReadV1;

type SourceReadContext = Readonly<{ credentials: StoredCredentials; serverHttpBaseUrl: string; signal: AbortSignal;
  isCurrent: () => Promise<boolean> }>;

/** A native terminal hint selects an existing host Turn, never a provider identity. */
export async function normalizeSessionFollowTerminalSourceOccurrence(input: SourceReadContext & Readonly<{
  occurrence: Extract<SessionFollowRuleSourceOccurrenceV1 | SessionFollowAccountOccurrence, { sourceMessage: unknown }>;
}>) {
  const occurrence = input.occurrence;
  if (occurrence.evidence.event.kind !== 'finished' && occurrence.evidence.event.kind !== 'failed_or_stopped') return null;
  if (!await input.isCurrent()) return null;
  const transport = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => resolveSessionTransportContext({ reason: 'follow-source-hydration',
    credentials: input.credentials, idOrPrefix: occurrence.sourceSessionId, signal: input.signal }));
  if (!transport.ok || !await input.isCurrent()) return null;
  const page = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => fetchEncryptedTranscriptMessagesPage({
    token: input.credentials.token, sessionId: occurrence.sourceSessionId, scope: 'all',
    afterSeq: occurrence.sourceMessage.seq - 1, limit: 1, signal: input.signal }));
  const row = page.messages.find(row => row.seq === occurrence.sourceMessage.seq && row.localId === occurrence.sourceMessage.localId);
  if (!row || row.sidechainId || !await input.isCurrent()) return null;
  const read = readCommittedSessionFollowSourceOccurrence({ sourceSessionId: occurrence.sourceSessionId,
    serverId: occurrence.evidence.facts.serverId, ownerAccountId: occurrence.evidence.ownerAccountId,
    origin: transport.rawSession.origin ?? null, row, mode: transport.mode, ctx: transport.ctx });
  if (read.status === 'unavailable') return null;
  if (read.status !== 'occurrence' || !('sourceTurn' in read.occurrence)
    || read.occurrence.evidence.event.kind !== occurrence.evidence.event.kind) return null;
  return { sourceSessionId: occurrence.sourceSessionId, sourceTurn: read.occurrence.sourceTurn,
    evidence: { ...occurrence.evidence, event: resolveSessionFollowTurnEventV1(read.occurrence.sourceTurn) },
    ...('sourcePublisher' in occurrence ? { sourcePublisher: occurrence.sourcePublisher } : {}) };
}

/** Exact persisted-original verification shared by source dispatch and ordinary live fallback. */
export async function readSessionFollowOriginalRoutes(input: SourceReadContext & Readonly<{
  occurrence: SessionFollowRuleSourceOccurrenceV1 | SessionFollowAccountOccurrence; destinationSessionId?: string;
}>) {
  const occurrence = input.occurrence;
  const request = SessionFollowObserveSourceRoutesRequestV1Schema.parse({ v: 1,
    ...('sourcePublisher' in occurrence ? { sourcePublisher: occurrence.sourcePublisher }
      : input.destinationSessionId ? { destinationSessionId: input.destinationSessionId } : {}),
    ...('sourceMessage' in occurrence ? { sourceMessage: occurrence.sourceMessage }
      : 'sourceTurn' in occurrence ? { sourceTurn: occurrence.sourceTurn } : { sourceRequests: occurrence.sourceRequests }) });
  const path = SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.occurrenceRoutes.replace(':sourceSessionId', encodeURIComponent(occurrence.sourceSessionId));
  const response = await axios.post(`${input.serverHttpBaseUrl}${path}`, request, {
    headers: { Authorization: `Bearer ${input.credentials.token}` }, signal: input.signal, validateStatus: () => true });
  if (response.status !== 200 || !await input.isCurrent()) return null;
  const parsed = SessionFollowObserveSourceRoutesResponseV1Schema.safeParse(response.data);
  return parsed.success && parsed.data.ok && parsed.data.sourceSessionId === occurrence.sourceSessionId ? parsed.data : null;
}

/** Opens one already-authorized committed row; callers own paging and current predicate facts. */
export function readCommittedSessionFollowSourceOccurrence(input: Pick<SourceFacts, 'serverId' | 'ownerAccountId' | 'origin'> & Readonly<{
  sourceSessionId: string; row: RawTranscriptRow; mode: SessionStoredContentEncryptionMode; ctx: SessionEncryptionContext | null;
}>): CommittedSessionFollowSourceOccurrenceRead {
  const row = SessionMessageV1Schema.safeParse(input.row);
  if (!row.success) return { status: 'unavailable' };
  if (row.data.sidechainId) return { status: 'not_semantic' };
  try {
    let opened: unknown;
    if (input.mode === 'plain') opened = openSessionStoredContent({ mode: 'plain', ctx: null, content: row.data.content });
    else {
      if (!input.ctx) return { status: 'unavailable' };
      opened = openSessionStoredContent({ mode: 'e2ee', ctx: input.ctx, content: row.data.content });
    }
    return readOpenedSessionFollowOriginalV1({ ...input, row: row.data, opened });
  } catch { return { status: 'unavailable' }; }
}

/** Original evidence carries only non-private source identity and semantic event facts. */
type SourceFacts = Readonly<{
  serverId: string; ownerAccountId: string; origin: SessionAwarenessOriginV1 | null;
  awareness?: SessionAwarenessProjectionV1;
}>;
export function captureSessionFollowRuleSourceEvidence(input: SourceFacts & Readonly<{ body: ACPMessageData }>): SessionFollowRuleSourceEvidenceV1 | null {
  const event = readSessionFollowSemanticSourceEvent(input.body);
  return event ? captureSemanticSessionFollowRuleSourceEvidence({ ...input, event }) : null;
}
