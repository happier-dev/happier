import * as z from 'zod/mini';
import { openSessionStateValue } from '@happier-dev/sync-client';
import { AgentStateSchema } from '@happier-dev/session-core/state';

import type {
  SessionAwarenessProjectionV1,
  SessionFollowUpdateEnvelopeV1,
  WorkerUpdateV1,
  VoiceSessionUpdatePolicyV1,
  VoiceSourceDisclosureV1,
} from '@happier-dev/protocol';
import type { SessionFollowSessionPendingObservationV1, SessionFollowAdmittedInputObservationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { isAuthoritativeHumanSessionFollowMessageV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowUpdateEnvelopeV1';
import { isSessionFollowTurnEqualV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { resolveVoiceSessionUpdatePolicyV1, resolveVoiceSourceDisclosureV1 } from '@happier-dev/protocol/voice/sourceDisclosureV1';
import { parseSessionMessageAccountActorV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { readSessionMessageProvenanceV1, SessionInputAdmissionResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { TranscriptRawAgentEventV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { classifyWorkerUpdateEventV1, composeSessionWorkerUpdateHeadlineV1, resolveWorkerUpdateWakeV1, WorkerUpdateV1Schema, workerDeliverablesBelongToSessionV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { resolveFollowDeliveryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { readSessionFollowSemanticSourceEvent } from './sessionFollowRuleSourceEvidence';
import { SessionFollowSourceMessageV1Schema, SessionFollowSourceRequestsV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { StoredCredentials } from '@/persistence';
import { classifyHomeReadPreparationError } from '@/agent/prompts/library/homeReadPreparationError';
import { readActiveForegroundAgentRequests, readForegroundAgentRequestFollowEvent } from '@/agent/permissions/activeForegroundRequests';
import { readStructuredQuestionPermissionQuestions } from '@/agent/permissions/structuredQuestionAnswers';
import {
  projectCliSessionAwarenessFromMaterialV1,
  projectCliSessionAwarenessUnavailableMaterialV1,
  projectCliSessionAwarenessV1,
} from '@/cli/output/session/sessionAwareness';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { decodeTranscriptBody } from '@/session/services/transcript/transcriptBodyDecoder';
import {
  openSessionStoredContent,
  encryptSessionPayload,
  decryptSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  resolveSessionTransportContextFromMaterial,
  type SessionEncryptionContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { fetchSessionFollowSourceProjection } from '@/session/transport/http/sessionFollowSourceProjectionHttp';

/** Public admitted originals have no native-readable route policy or private witness. */
export type SessionFollowHydrationObservationV1 = SessionFollowSessionPendingObservationV1
  | (SessionFollowAdmittedInputObservationV1 & Readonly<{ relation?: never; attachedAt?: never; policy?: never }>);
type SessionFollowPendingObservationV1 = SessionFollowHydrationObservationV1;

/**
 * Encryption-context seam for Lane 13 restricted-Runner prepared source keys.
 *
 * This is the typed extension point consumed by the ordinary Follow source
 * hydrator below. Lane 13 owns the receiver/lifetime that installs material;
 * this module never materializes keys, stores them on disk, or invents
 * Account-wide keys. The ordinary Account daemon path resolves `plain` or uses
 * its own Account credentials; a Runner destination supplies this resolver once
 * Lane 13 lands, and one reconciler serves both runtime kinds.
 */
export type SessionFollowSourceMaterialResolver = Readonly<{
  installPreparedDataKey(input: Readonly<{
    sourceSessionId: string;
    dataKey: Uint8Array;
  }>): 'installed';
  resolveForHydration(input: Readonly<{
    sourceSessionId: string;
    signal: AbortSignal;
  }>):
    | Readonly<{ mode: 'plain' }>
    | Readonly<{ mode: 'e2ee'; dataKey: Uint8Array }>
    | Readonly<{ mode: 'unavailable' }>;
}>;

export type SessionFollowHydratorDeps = Readonly<{
  resolveSourceTransport?: typeof resolveSessionTransportContext;
  fetchTranscriptPage?: typeof fetchEncryptedTranscriptMessagesPage;
  projectSourceAwareness?: (input: Readonly<{
    rawSession: Parameters<typeof projectCliSessionAwarenessV1>[0]['row'];
    accountEncryption: Parameters<typeof projectCliSessionAwarenessV1>[0]['accountEncryption'];
  }>) => SessionAwarenessProjectionV1;
  fetchRunnerSourceProjection?: typeof fetchSessionFollowSourceProjection;
}>;

export type SessionFollowHydratedUpdate = SessionFollowUpdateEnvelopeV1 & Readonly<{
  /** Host-only ordering evidence from the canonical source Session row. */
  sourceRecencyMs: number;
  /**
   * Exact contiguous transcript frontier represented after keeping the first
   * N rendered summaries. Index 0 covers valid non-renderable rows before the
   * first summary; the final entry includes valid non-renderable rows trailing
   * the last summary. This host-only evidence lets the context budget defer a
   * renderable row without leaving earlier semantic events pending forever.
   */
  transcriptConsumedThroughByRenderedMessageCount?: readonly number[];
  /**
   * Host-only wake discovery evidence: protected human ingress exists somewhere in
   * the pending range, possibly beyond the page delivered now. Present only when
   * discovery was requested.
   */
  pendingHumanIngress?: boolean;
  /** Manager delivery uses the same authorized hydration and source-owned worker outcome. */
  workerUpdate?: WorkerUpdateV1;
  /** Recheck outcome-specific evidence after Follow rechecks its source grant. */
  recheckWorkerUpdateAdmission?: (signal: AbortSignal) => Promise<boolean>;
  /** Only a successfully opened, sufficiently current request snapshot proves withdrawal. */
  isOriginalRequestWithdrawn?: () => boolean;
}>;

/**
 * The Account Voice disclosure ceiling for a daemon Follow read: the content
 * switches and the snippet controls the foreground Voice path applies, from the
 * same Protocol owners (`resolveVoiceSourceDisclosureV1`,
 * `resolveVoiceSessionUpdatePolicyV1`). A level of `none` discloses nothing.
 */
export type SessionFollowVoiceDisclosure = VoiceSourceDisclosureV1 & Pick<
  VoiceSessionUpdatePolicyV1,
  'includeUserMessagesInSnippets' | 'snippetsMaxMessages'
>;

/**
 * The Account's Voice disclosure for a daemon Account Voice Follow source. The
 * server publishes Account Voice observations only for Sessions the user opted
 * into Voice, so each source is included by construction. Unreadable settings
 * withhold rather than disclose.
 */
export function resolveAccountVoiceFollowDisclosure(accountSettings: unknown): SessionFollowVoiceDisclosure {
  const policyInput = { accountSettings, includeInVoice: true } as const;
  const policy = resolveVoiceSessionUpdatePolicyV1(policyInput);
  return {
    ...resolveVoiceSourceDisclosureV1(policyInput),
    includeUserMessagesInSnippets: policy.includeUserMessagesInSnippets,
    snippetsMaxMessages: policy.snippetsMaxMessages,
  };
}

/** Selects the shared transcript read semantics before provider-context budgeting. */
export type SessionFollowHydrationReadModeV1 =
  | 'incremental'
  | 'initial_current_snapshot';

type SessionFollowOpenedTranscriptRow = Readonly<{
  seq: number;
  role: 'user' | 'agent';
  content: unknown;
  meta?: unknown;
  accountActor?: unknown;
  sidechainId?: unknown;
}>;

type SessionFollowTranscriptRowOpenResult =
  | Readonly<{ ok: true; row: SessionFollowOpenedTranscriptRow }>
  | Readonly<{ ok: false; reason: 'invalid_row' | 'content_unavailable' }>;

function recordValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

/** Parse actual MCP/Action admission output, never a tool-attempt summary. */
function isAcceptedCrossSessionSendOutput(output: unknown): boolean {
  let value = output;
  const content = Array.isArray(value) ? value : recordValue(value)?.content;
  if (Array.isArray(content)) {
    const text = content.flatMap((part) => {
      const record = recordValue(part);
      return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
    }).join('\n');
    try { value = JSON.parse(text); } catch { return false; }
  } else if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return false; }
  }
  const envelope = recordValue(value);
  if (envelope?.ok === true) value = envelope.result;
  const parsed = SessionInputAdmissionResultV1Schema.safeParse(value);
  return parsed.success && (parsed.data.status === 'accepted' || parsed.data.status === 'alreadyAccepted');
}

function openSessionFollowTranscriptRow(input: Readonly<{
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext | null;
  row: Readonly<{
    seq?: unknown;
    createdAt?: unknown;
    content?: unknown;
    accountActor?: unknown;
    sidechainId?: unknown;
  }>;
}>): SessionFollowTranscriptRowOpenResult {
  const seq = typeof input.row.seq === 'number' && Number.isSafeInteger(input.row.seq) && input.row.seq >= 0
    ? input.row.seq
    : null;
  const createdAt = typeof input.row.createdAt === 'number'
    && Number.isSafeInteger(input.row.createdAt)
    && input.row.createdAt >= 0
    ? input.row.createdAt
    : null;
  const content = SessionStoredMessageContentSchema.safeParse(input.row.content);
  if (seq === null || createdAt === null || !content.success) {
    return { ok: false, reason: 'invalid_row' };
  }

  let opened: unknown;
  try {
    if (input.mode === 'plain') {
      opened = openSessionStoredContent({ mode: 'plain', ctx: null, content: content.data });
    } else {
      if (!input.ctx) return { ok: false, reason: 'content_unavailable' };
      opened = openSessionStoredContent({ mode: 'e2ee', ctx: input.ctx, content: content.data });
    }
  } catch {
    // The canonical opener distinguishes mode mismatch from unavailable E2EE
    // bytes. Follow deliberately projects both as the same content-free,
    // retryable omission so neither ciphertext nor corruption details leak.
    return { ok: false, reason: 'content_unavailable' };
  }
  if (!opened || typeof opened !== 'object' || Array.isArray(opened)) {
    return { ok: false, reason: 'invalid_row' };
  }
  const record = opened as Readonly<Record<string, unknown>>;
  if (record.role !== 'user' && record.role !== 'agent') {
    return { ok: false, reason: 'invalid_row' };
  }
  return {
    ok: true,
    row: {
      seq,
      role: record.role,
      content: record.content,
      sidechainId: input.row.sidechainId ?? record.sidechainId,
      ...(record.meta !== undefined ? { meta: record.meta } : {}),
      ...(input.row.accountActor !== undefined ? { accountActor: input.row.accountActor } : {}),
    },
  };
}

function readAuthorLabel(accountActor: unknown): string | null {
  const actor = parseSessionMessageAccountActorV1(accountActor);
  if (!actor?.profile) return null;
  const fullName = [actor.profile.firstName, actor.profile.lastName]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .trim();
  const label = fullName || actor.profile.username?.trim() || null;
  return label?.replace(/\s+/gu, ' ').trim().slice(0, 191) || null;
}

type SessionFollowRowSummary = SessionFollowUpdateEnvelopeV1['recentMessages'][number];

/**
 * One opened transcript row as Follow sees it: its model-visible summary, or
 * `null` for a valid row with no useful model-visible text (consumed by
 * traversal, never invented into prose). Shared by delivery and wake discovery
 * so both classify rows identically.
 */
function projectOpenedSessionFollowRow(row: SessionFollowOpenedTranscriptRow, noticeOnlyHuman: boolean, voiceSourceSessionId?: string): Readonly<{
  summary: SessionFollowRowSummary | null;
  userMessage: boolean;
}> {
  const content = recordValue(row.content);
  if (row.role === 'agent' && content?.type === 'event') {
    const event = createStoredReadSchema(TranscriptRawAgentEventV1Schema).safeParse(content.data);
    if (event.success && event.data.type === 'goal-changed') {
      return { summary: { messageId: `seq:${row.seq}`, seq: row.seq,
        text: 'The goal changed in the source session. Open the source session to read it.',
        event: { kind: 'goal_changed' }, provenance: null }, userMessage: false };
    }
    if (voiceSourceSessionId && recordValue(content.data)?.type === 'worker-report') {
      if (!event.success || event.data.type !== 'worker-report'
        || !workerDeliverablesBelongToSessionV1(event.data.deliverables, voiceSourceSessionId)) {
        return { summary: null, userMessage: false };
      }
      return { summary: { messageId: `seq:${row.seq}`, seq: row.seq,
        text: event.data.summary, provenance: null }, userMessage: false };
    }
  }
  const decoded = decodeTranscriptBody({ role: row.role, content: row.content, meta: row.meta });
  const semanticText = decoded?.text ?? decoded?.summary;
  if (!semanticText || semanticText.trim().length === 0) return { summary: null, userMessage: false };
  const authorLabel = readAuthorLabel(row.accountActor);
  const provenance = readSessionMessageProvenanceV1(row.meta, 'stored');
  return {
    summary: {
      messageId: `seq:${row.seq}`,
      seq: row.seq,
      text: noticeOnlyHuman && isAuthoritativeHumanSessionFollowMessageV1({ provenance })
        ? 'A person wrote in the source session. Open the source message to read it.'
        : semanticText,
      ...(authorLabel ? { authorLabel } : {}),
      provenance,
    },
    userMessage: decoded?.semanticRole === 'user',
  };
}

function readSourceRecencyMs(rawSession: unknown): number {
  if (!rawSession || typeof rawSession !== 'object') return 0;
  const record = rawSession as Readonly<Record<string, unknown>>;
  return Math.max(0, ...[record.updatedAt, record.activeAt, record.createdAt].flatMap((candidate) => (
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      ? [candidate]
      : []
  )));
}

function buildUnavailableEnvelope(input: Readonly<{
  observation: SessionFollowPendingObservationV1;
  awareness: SessionAwarenessProjectionV1;
}>): SessionFollowUpdateEnvelopeV1 {
  return {
    v: 1,
    kind: 'session_follow_update',
    edge: {
      sourceSessionId: input.observation.sourceSessionId,
      destinationSessionId: input.observation.destinationSessionId,
    },
    reason: 'source_unavailable',
    deliveryIntent: 'context_only',
    observed: input.observation.observed,
    awareness: input.awareness,
    recentMessages: [],
    truncated: false,
  };
}

/**
 * Canonical source-content hydrator for Session Follow.
 *
 * It reuses the existing Session transport/encryption/transcript/awareness
 * owners: `resolveSessionTransportContext` for authenticated fetch plus
 * encryption context, `fetchEncryptedTranscriptMessagesPage` for bounded
 * transcript reads, `openSessionStoredContent` + `decodeTranscriptBody` +
 * `readSessionMessageProvenanceV1` for content, and `projectCliSessionAwarenessV1`
 * for awareness. Every HTTP read stays inside the destination Session client's
 * exact Home context and rejects mismatched credentials. It never creates a
 * second decryptor, HTTP client, key store, or queue.
 *
 * The hydrated envelope is always capped to the originally observed frontier:
 * only messages with `delivered < seq <= observed` are included, so a newer
 * hydration frontier can never be acknowledged by the earlier turn. Unknown,
 * unavailable, or key-not-ready material returns a `source_unavailable`
 * envelope (visible, retryable, unacknowledged) or `null` when even the
 * relationship cannot be disclosed safely.
 */
export function createSessionFollowSourceHydrator(input: Readonly<{
  session: Pick<ApiSessionClient, 'sessionId' | 'runSessionFollowSourceRequest'>;
  credentials: StoredCredentials;
  sourceMaterialResolver?: SessionFollowSourceMaterialResolver | null;
  /**
   * Account-owned Voice disclosure ceiling for this read, from the one Protocol
   * owner the foreground Voice path also asks
   * (`resolveVoiceSourceDisclosureV1`). Omitted for ordinary
   * Session-to-Session Follow, which the Voice privacy settings do not govern.
   *
   * A withheld class is omitted from the envelope, never rendered and then
   * trimmed: the frontier this read represents stays exact, so the observation
   * still settles instead of being replayed forever as undisclosable.
   */
  disclosure?: SessionFollowVoiceDisclosure | null;
  deps?: SessionFollowHydratorDeps;
}>): (args: Readonly<{
  observation: SessionFollowPendingObservationV1;
  signal: AbortSignal;
  /** Omitted direct callers retain ordinary oldest-contiguous Follow behavior. */
  readMode?: SessionFollowHydrationReadModeV1;
  /** Also classify the pending range beyond the delivered page for protected human ingress. */
  discoverHumanIngress?: boolean;
  /** Modern Account Voice only; legacy current-context ingress retains its own semantics. */
  selectionChannel?: 'voice';
}>) => Promise<SessionFollowHydratedUpdate | null> {
  const mayQuoteSourceMessages = input.disclosure?.shareRecentMessages !== false;
  const mayDescribeSourceWork = input.disclosure?.shareSessionSummary !== false;
  /** Drops the work headline while keeping the source's identity and lifecycle. */
  const projectDisclosedAwareness = (awareness: SessionAwarenessProjectionV1): SessionAwarenessProjectionV1 => {
    if (mayDescribeSourceWork || awareness.currentWork === undefined) return awareness;
    const { currentWork: _withheld, ...disclosed } = awareness;
    return disclosed;
  };
  const resolveTransport = input.deps?.resolveSourceTransport ?? resolveSessionTransportContext;
  const fetchPage = input.deps?.fetchTranscriptPage ?? fetchEncryptedTranscriptMessagesPage;
  const fetchRunnerProjection = input.deps?.fetchRunnerSourceProjection ?? fetchSessionFollowSourceProjection;

  return async ({ observation, signal, readMode = 'incremental', discoverHumanIngress = false, selectionChannel }) => {
    signal.throwIfAborted();
    const isManager = observation.relation === 'manager';
    // Manager lifecycle evidence traverses the source's original range. Only
    // Account Voice's explicit current-context inclusion uses a snapshot baseline.
    if (isManager) readMode = 'incremental';
    // The foreground Voice path returns before any source update at level `none`;
    // the daemon read discloses nothing either, not even source awareness.
    if (input.disclosure?.level === 'none') return null;
    const destinationSessionId = input.session.sessionId;
    if (
      observation.destinationSessionId !== destinationSessionId
      || observation.sourceSessionId === destinationSessionId
    ) {
      return null;
    }

    const useRunnerProjection = input.sourceMaterialResolver && !input.deps?.resolveSourceTransport;
    const fetchRunnerPage = async (afterTranscriptSeq: number, requestSignal = signal) => await input.session.runSessionFollowSourceRequest({
      credentials: input.credentials,
      request: async () => await fetchRunnerProjection({
        token: input.credentials.token,
        destinationSessionId,
        sourceSessionId: observation.sourceSessionId,
        ...('kind' in observation ? { localInputId: observation.localInputId } : {}),
        ...(observation.relation ? { relation: observation.relation, attachedAt: observation.attachedAt } : {}),
        readMode: 'incremental',
        afterTranscriptSeq,
        observedTranscriptSeq: observation.observed.transcriptSeq,
        limit: SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1,
        signal: requestSignal,
      }),
    });
    const fetchAccountPageAfter = async (afterSeq: number) => await input.session.runSessionFollowSourceRequest({
      credentials: input.credentials,
      request: async () => await fetchPage({
        token: input.credentials.token,
        sessionId: observation.sourceSessionId,
        limit: SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1,
        scope: 'all',
        // `afterSeq` is the route's ascending catch-up arm.
        afterSeq,
        ...(signal ? { signal } : {}),
      }),
    });
    // Account Voice's independent initial snapshot is unsupported on the
    // restricted Runner projection; manager reads always traverse originals.
    if (readMode === 'initial_current_snapshot' && useRunnerProjection) return null;
    const runnerProjection = useRunnerProjection
      ? await fetchRunnerPage(observation.delivered.transcriptSeq).catch(error => {
          if ('kind' in observation) {
            const preparationError = classifyHomeReadPreparationError(error);
            if (preparationError !== error) throw preparationError;
          }
          return null;
        })
      : null;

    let transport: Awaited<ReturnType<typeof resolveSessionTransportContext>> | null = null;

    try {
      if (useRunnerProjection) {
        if (!runnerProjection || runnerProjection.source.id !== observation.sourceSessionId) return null;
        const mode = resolveSessionStoredContentEncryptionMode(runnerProjection.source);
        transport = {
          ok: true,
          sessionId: observation.sourceSessionId,
          rawSession: runnerProjection.source,
          accountEncryptionCurrentness: { mode },
          ctx: null,
          mode,
        } as Awaited<ReturnType<typeof resolveSessionTransportContext>>;
      } else {
        transport = await input.session.runSessionFollowSourceRequest({
          credentials: input.credentials,
          request: async () => await resolveTransport({ reason: 'follow-source-hydration',
            credentials: input.credentials,
            idOrPrefix: observation.sourceSessionId,
            ...(signal ? { signal } : {}),
          }),
        });
      }
    } catch (error) {
      if ('kind' in observation) {
        const preparationError = classifyHomeReadPreparationError(error);
        if (preparationError !== error) throw preparationError;
      }
      return null;
    }
    if (!transport || transport.ok !== true) {
      // Unknown, key-not-ready, or unreadable sources stay pending and retryable.
      // When the row itself is readable the transcript fetch below still yields a
      // visible `source_unavailable` envelope; otherwise this omission stays pending.
      return null;
    }

    const rawSession = transport.rawSession as unknown as Parameters<typeof projectCliSessionAwarenessV1>[0]['row'];
    const sourceRecencyMs = readSourceRecencyMs(transport.rawSession);
    const mode = resolveSessionStoredContentEncryptionMode(transport.rawSession as { encryptionMode?: unknown });
    const preparedMaterial = input.sourceMaterialResolver && mode === 'e2ee'
      ? input.sourceMaterialResolver.resolveForHydration({ sourceSessionId: observation.sourceSessionId, signal })
      : null;
    try {
      const runnerPresentationMaterial = useRunnerProjection
        ? mode === 'plain'
          ? { mode: 'plain' as const }
          : preparedMaterial?.mode === 'e2ee'
            ? { mode: 'e2ee' as const, dataEncryptionKey: preparedMaterial.dataKey }
            : null
        : null;
      const awareness = input.deps?.projectSourceAwareness
        ? input.deps.projectSourceAwareness({ rawSession, accountEncryption: transport.accountEncryptionCurrentness })
        : runnerPresentationMaterial
          ? projectCliSessionAwarenessFromMaterialV1({
              row: rawSession,
              material: runnerPresentationMaterial,
              nowMs: Date.now(),
            })
          : useRunnerProjection
            ? projectCliSessionAwarenessUnavailableMaterialV1({ row: rawSession, nowMs: Date.now() })
            : projectCliSessionAwarenessV1({
                credentials: input.credentials,
                accountEncryption: transport.accountEncryptionCurrentness,
                row: rawSession,
                nowMs: Date.now(),
              });

      if (awareness.sessionId !== observation.sourceSessionId) {
        return null;
      }
      const pendingReviewRuns = rawSession.pendingReviewRuns;
      // Follow's numeric frontier also advances for diagnostics and Agent-state
      // writes. Only a new terminal turn is another worker outcome; the existing
      // edge ACK already records the exact turn accepted by the lead.
      const terminalTurnAlreadyDelivered = observation.observed.turn !== null
        && isSessionFollowTurnEqualV1(observation.delivered.turn, observation.observed.turn);
      const workerState = observation.observed.turn?.status === 'stalled' && !terminalTurnAlreadyDelivered
        && (observation.relation === 'manager' || !('kind' in observation) && !('voiceExpected' in observation)) ? 'stalled'
        : observation.relation === 'manager'
        ? observation.observed.turn?.status === 'waiting'
          // A yielded question is an exact host lifecycle occurrence. Its
          // accepted frontier, not AgentState/content/count changes, owns replay.
          ? terminalTurnAlreadyDelivered
            || rawSession.latestTurnId !== observation.observed.turn.id
            || rawSession.latestTurnStatus !== 'waiting' ? null : 'needs_input'
          : awareness.operational.primary === 'permission_required' || awareness.operational.primary === 'action_required' ? 'needs_input'
            : null
        : null;
      let workerText: Readonly<{ text: string; seq: number; agentId?: string }> | null = null;
      let publishedReport: Readonly<{ text: string; seq: number; deliverables?: WorkerUpdateV1['deliverables'] }> | null = null;
      let reachedObservedTranscript = observation.observed.transcriptSeq <= observation.delivered.transcriptSeq;
      let workerAdmission: Pick<SessionFollowHydratedUpdate, 'recheckWorkerUpdateAdmission' | 'isOriginalRequestWithdrawn'> = workerState === 'needs_input' && observation.observed.turn?.status === 'waiting' ? {
        recheckWorkerUpdateAdmission: async (recheckSignal: AbortSignal) => {
          try {
            // Answer admission can replace the ended waiting turn after its
            // frontier was observed. Reuse the authorized source read before
            // dispatch rather than waking the manager for that stale question.
            const current = useRunnerProjection
              ? (await fetchRunnerPage(observation.delivered.transcriptSeq, recheckSignal))?.source
              : await input.session.runSessionFollowSourceRequest({ credentials: input.credentials,
                  request: async () => {
                    const result = await resolveTransport({ reason: 'follow-source-hydration', credentials: input.credentials,
                      idOrPrefix: observation.sourceSessionId, signal: recheckSignal });
                    return result.ok ? result.rawSession : null;
                  } });
            return !recheckSignal.aborted && current?.id === observation.sourceSessionId
              && current.latestTurnId === observation.observed.turn?.id
              && current.latestTurnStatus === 'waiting';
          } catch {
            return false;
          }
        },
      } : {};
      const outgoingCalls = new Map<string, Readonly<{ target: string; message: string; seq: number }>>();
      let lastOutgoingSend: Readonly<{ target: string; message: string; seq: number; accepted: boolean }> | null = null;
      const composeWorkerUpdate = (): WorkerUpdateV1 | undefined => {
        if (!workerState && !publishedReport) return undefined;
        if (!reachedObservedTranscript) return undefined;
        const ownerState = publishedReport ? 'published' : workerState;
        if (!ownerState) return undefined;
        const event = classifyWorkerUpdateEventV1({ workerKind: 'session', ownerState });
        if (!event) return undefined;
        const issue = ownerState === 'failed' && rawSession.latestTurnId === observation.observed.turn?.id
          ? SessionRuntimeIssueV1Schema.safeParse(rawSession.lastRuntimeIssue) : null;
        const repeatedFinalText = workerText && lastOutgoingSend?.accepted
          && lastOutgoingSend.target === observation.destinationSessionId && lastOutgoingSend.message.includes(workerText.text);
        const result = publishedReport ?? (repeatedFinalText ? null : workerText);
        const wake = resolveWorkerUpdateWakeV1(event);
        const headline = composeSessionWorkerUpdateHeadlineV1({ ownerState, wake });
        return WorkerUpdateV1Schema.parse({
          v: 1, workerKind: 'session', workerId: observation.sourceSessionId, ownerState,
          wake,
          ...(issue?.success ? { runtimeIssueV1: issue.data } : {}),
          headline, ...(result ? { result: result.text.slice(0, 8000) } : {}),
          ...(publishedReport?.deliverables ? { deliverables: publishedReport.deliverables } : {}),
          ...(result && result.text.length > 8000 ? { truncated: true } : {}),
          ...(workerText?.agentId ? { engine: { agentId: workerText.agentId } } : {}),
          transcriptPointer: { kind: 'session', sessionId: observation.sourceSessionId, ...((result ?? workerText) ? { seq: (result ?? workerText)!.seq } : {}) },
          canInspect: true,
        });
      };
      // AWI-06: the projection above is the single readability answer for every
      // content-derived fact, transcript summaries included. A source whose
      // metadata is absent, unparseable, or unopenable projects `locked`-class
      // encryption even when the resolved key still opens transcript rows, and
      // `SessionFollowUpdateEnvelopeV1Schema` rejects summaries beside such a
      // projection. Because the reconciler renders every candidate through that
      // validator, emitting them here discards the whole turn's Follow context
      // instead of this one source. Stay visible, unacknowledged, and retryable.
      if (!isSessionAwarenessContentReadableV1(awareness.encryption)) {
        return { ...buildUnavailableEnvelope({ observation, awareness }), sourceRecencyMs };
      }

      let resolvedMaterial: ReturnType<SessionFollowSourceMaterialResolver['resolveForHydration']> | null = null;
      if (input.sourceMaterialResolver && mode === 'e2ee') {
        resolvedMaterial = preparedMaterial;
        if (!resolvedMaterial || resolvedMaterial.mode === 'unavailable') {
          return { ...buildUnavailableEnvelope({ observation, awareness }), sourceRecencyMs };
        }
      }
      let ctx: SessionEncryptionContext | null = null;
      if (resolvedMaterial) {
        if (resolvedMaterial.mode === 'plain') {
          if (mode !== 'plain') return { ...buildUnavailableEnvelope({ observation, awareness }), sourceRecencyMs };
          ctx = null;
        } else {
          const materialized = resolveSessionTransportContextFromMaterial({
            rawSession: transport.rawSession as { encryptionMode?: unknown },
            material: { mode: 'e2ee', dataEncryptionKey: resolvedMaterial.dataKey },
          });
          if (!materialized.ok) return { ...buildUnavailableEnvelope({ observation, awareness }), sourceRecencyMs };
          ctx = materialized.ctx;
        }
      } else if (mode === 'plain') {
        ctx = null;
      } else {
        const ordinary = resolveSessionEncryptionContextFromCredentials(
          input.credentials,
          transport.rawSession as unknown as Parameters<typeof resolveSessionEncryptionContextFromCredentials>[1],
        );
        if (!ordinary) return { ...buildUnavailableEnvelope({ observation, awareness }), sourceRecencyMs };
        ctx = ordinary;
      }

      const selectsVoiceOriginals = selectionChannel === 'voice' && readMode === 'incremental' && !('kind' in observation);
      if ('kind' in observation && 'sourceTurn' in observation.delivery.original) {
        // The admitted input already selected and verified this exact host
        // outcome. This projection opens only its anchored final message; it
        // cannot choose another terminal meaning or consume transcript progress.
        const projection = runnerProjection ?? await fetchRunnerPage(0);
        if (!projection) return { ...buildUnavailableEnvelope({ observation, awareness }), sourceRecencyMs };
        let final: Readonly<{ text: string; seq: number }> | undefined;
        for (const row of projection.messages) {
          const opened = openSessionFollowTranscriptRow({ mode, ctx, row });
          if (!opened.ok) return { ...buildUnavailableEnvelope({ observation, awareness }), sourceRecencyMs };
          const decoded = decodeTranscriptBody({ role: opened.row.role, content: opened.row.content, meta: opened.row.meta });
          if (decoded?.semanticRole === 'assistant' && decoded.text && !decoded.sidechainId) final = { text: decoded.text, seq: row.seq };
        }
        const turn = observation.delivery.original.sourceTurn;
        if (turn.status === 'completed' && pendingReviewRuns !== 0) return null;
        const ownerState = turn.status === 'completed' ? 'settled' : turn.status;
        const wake = resolveWorkerUpdateWakeV1(classifyWorkerUpdateEventV1({ workerKind: 'session', ownerState })!);
        const issue = turn.status === 'failed' ? SessionRuntimeIssueV1Schema.safeParse(projection.source.lastRuntimeIssue) : null;
        const result = final?.text;
        return { v: 1, kind: 'session_follow_update', edge: {
          sourceSessionId: observation.sourceSessionId, destinationSessionId: observation.destinationSessionId,
        }, reason: 'source_changed', deliveryIntent: 'context_only', observed: observation.observed,
          awareness: projectDisclosedAwareness(awareness), recentMessages: [], truncated: false, sourceRecencyMs,
          transcriptConsumedThroughByRenderedMessageCount: [observation.observed.transcriptSeq],
          workerUpdate: WorkerUpdateV1Schema.parse({ v: 1, workerKind: 'session', workerId: observation.sourceSessionId,
            ownerState, wake, headline: composeSessionWorkerUpdateHeadlineV1({ ownerState, wake }),
            ...(result ? { result: result.slice(0, 8000), ...(result.length > 8000 ? { truncated: true } : {}) } : {}),
            ...(issue?.success ? { runtimeIssueV1: issue.data } : {}),
            transcriptPointer: { kind: 'session', sessionId: observation.sourceSessionId, ...(final ? { seq: final.seq } : {}) }, canInspect: true }),
        };
      }
      const requestContext = ctx;
      let questionOffers: SessionFollowUpdateEnvelopeV1['questionOffers'];
      const readLiveRequests = async (source: Readonly<{
          agentState?: string | null; agentStateVersion?: number; encryptionMode?: unknown;
        }>, minimumVersion: number) => {
          if (typeof source.agentStateVersion !== 'number' || !Number.isSafeInteger(source.agentStateVersion) || source.agentStateVersion < minimumVersion
            || typeof source.agentState !== 'string' || resolveSessionStoredContentEncryptionMode(source) !== mode) return null;
          const opened = await openSessionStateValue(mode === 'plain' ? { mode: 'plain' } : {
            mode: 'e2ee', encryption: requestContext ? {
              encryptRaw: async payload => encryptSessionPayload({ ctx: requestContext, payload }),
              decryptRaw: async ciphertextBase64 => decryptSessionPayload({ ctx: requestContext, ciphertextBase64 }),
            } : null,
          }, source.agentState);
          if (opened.status !== 'ready') return null;
          const parsed = AgentStateSchema.safeParse(opened.value);
          return parsed.success ? readActiveForegroundAgentRequests(parsed.data) : null;
      };
      if ('kind' in observation && 'sourceRequests' in observation.delivery.original) {
        const original = observation.delivery.original.sourceRequests;
        let withdrawn = false;
        const readCurrentOriginalRequests = async (source: Parameters<typeof readLiveRequests>[0]) => {
          const active = await readLiveRequests(source, original.agentStateVersion);
          const live = active !== null && original.requests.every(request => active.some(([requestId, current]) => requestId === request.requestId
            && current.createdAt === request.createdAt && current.turnId === request.turnId
            && (!request.currentHandler || request.currentHandler.kind === 'session'
              && request.currentHandler.sessionId === observation.destinationSessionId
              && current.currentHandler?.kind === 'session' && current.currentHandler.sessionId === request.currentHandler.sessionId)));
          withdrawn = active !== null && !live;
          return live && (!questionOffers?.length || questionOffers.every(offer => active?.some(([id, request]) =>
            id === offer.requestId && request.currentHandler?.kind === 'session'
            && request.currentHandler.sessionId === observation.destinationSessionId))) ? active : null;
        };
        workerAdmission = { isOriginalRequestWithdrawn: () => withdrawn,
          recheckWorkerUpdateAdmission: async (requestSignal: AbortSignal) => {
          try {
            requestSignal.throwIfAborted();
            if (useRunnerProjection) {
              const current = await fetchRunnerPage(observation.delivered.transcriptSeq, requestSignal);
              return !requestSignal.aborted && current?.source.id === observation.sourceSessionId
                && (await readCurrentOriginalRequests(current.source)) !== null;
            }
            const current = await input.session.runSessionFollowSourceRequest({ credentials: input.credentials,
              request: () => resolveTransport({ reason: 'follow-source-hydration', credentials: input.credentials, idOrPrefix: observation.sourceSessionId,
                signal: requestSignal }) });
            return !requestSignal.aborted && current.ok && current.sessionId === observation.sourceSessionId
              && (await readCurrentOriginalRequests(current.rawSession)) !== null;
          } catch (error) {
            const preparationError = classifyHomeReadPreparationError(error);
            if (preparationError !== error) throw preparationError;
            return false;
          }
        } };
        const active = await readCurrentOriginalRequests(transport.rawSession);
        if (active === null) {
          return { ...buildUnavailableEnvelope({ observation, awareness }), sourceRecencyMs, ...workerAdmission };
        }
        // Reuse the already authorized exact source snapshot. Only the request
        // owner's assigned handler receives the form; this is presentation,
        // never another manager/answer-eligibility decision.
        questionOffers = active.flatMap(([requestId, request]) => {
          const event = readForegroundAgentRequestFollowEvent(request);
          if (!original.requests.some(original => original.requestId === requestId && original.currentHandler?.kind === 'session'
              && original.currentHandler.sessionId === observation.destinationSessionId)
            || request.currentHandler?.kind !== 'session'
            || request.currentHandler.sessionId !== observation.destinationSessionId
            || event?.kind !== 'needs_you' || event.type === 'approval') return [];
          const questions = readStructuredQuestionPermissionQuestions({ toolName: request.tool, toolInput: request.arguments });
          return questions.length ? [{ requestId, currentHandler: request.currentHandler,
            ...(request.questionV1 ? { questionV1: request.questionV1 } : {}), questions }] : [];
        });
      }

      const deliveredSeq = observation.delivered.transcriptSeq;
      const observedSeq = observation.observed.transcriptSeq;
      const selectedVoiceRequests = selectsVoiceOriginals && observation.policy !== undefined
        && observation.observed.agentStateVersion > observation.delivered.agentStateVersion
        && transport.rawSession.agentStateVersion === observation.observed.agentStateVersion
        ? (await readLiveRequests(transport.rawSession, observation.observed.agentStateVersion) ?? []).filter(([requestId, request]) => {
            if (!SessionFollowSourceRequestsV1Schema.safeParse({ agentStateVersion: observation.observed.agentStateVersion,
              requests: [{ requestId, createdAt: request.createdAt, ...(request.turnId ? { turnId: request.turnId } : {}) }] }).success) return false;
            const event = readForegroundAgentRequestFollowEvent(request);
            return event !== null && resolveFollowDeliveryV1({ policies: [observation.policy!], event }).person.voice;
          }) : [];
      if (selectedVoiceRequests.length > 0) {
        workerAdmission = { recheckWorkerUpdateAdmission: async (requestSignal: AbortSignal) => {
          try {
            const current = await input.session.runSessionFollowSourceRequest({ credentials: input.credentials,
              request: () => resolveTransport({ reason: 'follow-source-hydration', credentials: input.credentials, idOrPrefix: observation.sourceSessionId,
                signal: requestSignal }) });
            if (requestSignal.aborted || !current.ok || current.sessionId !== observation.sourceSessionId) return false;
            const active = await readLiveRequests(current.rawSession, observation.observed.agentStateVersion);
            return active !== null && selectedVoiceRequests.every(([id, original]) => active.some(([requestId, request]) =>
              requestId === id && request.createdAt === original.createdAt && request.turnId === original.turnId
              && JSON.stringify(readForegroundAgentRequestFollowEvent(request)) === JSON.stringify(readForegroundAgentRequestFollowEvent(original))));
          } catch { return false; }
        } };
      }
      const originalTurnEvent = observation.observed.turn?.status === 'completed' ? { kind: 'finished' as const }
        : observation.observed.turn?.status === 'failed' || observation.observed.turn?.status === 'cancelled'
          ? { kind: 'failed_or_stopped' as const }
          : observation.observed.turn?.status === 'stalled' ? { kind: 'stalled' as const } : null;
      const selectedVoiceTurn = selectsVoiceOriginals && observation.policy !== undefined && !terminalTurnAlreadyDelivered
        && originalTurnEvent !== null && resolveFollowDeliveryV1({ policies: [observation.policy], event: originalTurnEvent }).person.voice;
      if (observedSeq <= deliveredSeq && observation.relation !== 'manager') {
        if (selectsVoiceOriginals && !selectedVoiceTurn && selectedVoiceRequests.length === 0) return null;
        return {
          v: 1,
          kind: 'session_follow_update',
          edge: {
            sourceSessionId: observation.sourceSessionId,
            destinationSessionId: observation.destinationSessionId,
          },
          reason: 'source_changed',
          deliveryIntent: 'context_only',
          observed: observation.observed,
          awareness: projectDisclosedAwareness(awareness),
          recentMessages: [],
          ...(questionOffers?.length ? { questionOffers } : {}),
          truncated: false,
          sourceRecencyMs,
          transcriptConsumedThroughByRenderedMessageCount: [deliveredSeq],
          ...(composeWorkerUpdate() ? { workerUpdate: composeWorkerUpdate() } : {}),
          ...workerAdmission,
        };
      }

      let rows: Awaited<ReturnType<typeof fetchPage>>['messages'];
      let pageHasMore = false;
      if (readMode === 'initial_current_snapshot' && observedSeq >= Number.MAX_SAFE_INTEGER) {
        return { ...buildUnavailableEnvelope({ observation, awareness }), sourceRecencyMs };
      }
      try {
        const page = runnerProjection ?? (readMode === 'initial_current_snapshot'
          ? await input.session.runSessionFollowSourceRequest({
              credentials: input.credentials,
              request: async () => await fetchPage({
                token: input.credentials.token,
                sessionId: observation.sourceSessionId,
                limit: SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1,
                scope: 'all',
                // The route's `beforeSeq` arm returns the latest bounded window
                // in descending order. The exclusive cap prevents a concurrent
                // source advance from entering this originally observed snapshot.
                beforeSeq: observedSeq + 1,
                ...(signal ? { signal } : {}),
              }),
            })
          // Reading from the delivered frontier preserves a contiguous ACK prefix.
          : await fetchAccountPageAfter(deliveredSeq));
        rows = readMode === 'initial_current_snapshot'
          ? [...page.messages].reverse()
          : [...page.messages];
        pageHasMore = page.hasMore;
      } catch (error) {
        if ('kind' in observation) {
          const preparationError = classifyHomeReadPreparationError(error);
          if (preparationError !== error) throw preparationError;
        }
        return { ...buildUnavailableEnvelope({ observation, awareness }), sourceRecencyMs };
      }

      const summaries: SessionFollowUpdateEnvelopeV1['recentMessages'] = [];
      const summaryIsUserMessage: boolean[] = [];
      // Entry N is the exact contiguous transcript frontier after rendering N
      // summaries. Structurally valid rows without model-visible text advance
      // the current entry; malformed or unopenable rows stop traversal.
      const firstStoredSeq = rows[0]?.seq;
      const traversalBaseline = readMode === 'initial_current_snapshot'
        && typeof firstStoredSeq === 'number'
        && Number.isSafeInteger(firstStoredSeq)
        ? firstStoredSeq - 1
        : deliveredSeq;
      const consumedThroughByRenderedMessageCount: number[] = [traversalBaseline];
      let omittedObservedMessage = false;
      let nextContiguousSeq = traversalBaseline + 1;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const storedRow = rows[rowIndex]!;
        const storedSeq = typeof storedRow.seq === 'number' && Number.isSafeInteger(storedRow.seq)
          ? storedRow.seq
          : null;
        if (readMode === 'incremental' && storedSeq !== null && storedSeq <= deliveredSeq) continue;
        if (storedSeq !== null && storedSeq > observedSeq) {
          omittedObservedMessage = nextContiguousSeq <= observedSeq;
          break;
        }
        if (storedSeq !== nextContiguousSeq) {
          omittedObservedMessage = true;
          break;
        }
        const opened = openSessionFollowTranscriptRow({ mode, ctx, row: storedRow });
        if (!opened.ok) {
          omittedObservedMessage = true;
          break;
        }
        const row = opened.row;
        if ('kind' in observation && 'sourceMessage' in observation.delivery.original
          && row.seq === observation.delivery.original.sourceMessage.seq && row.role === 'agent'
          && recordValue(row.content)?.type === 'event'
          && recordValue(recordValue(row.content)?.data)?.type === 'worker-report') {
          const event = createStoredReadSchema(TranscriptRawAgentEventV1Schema).safeParse(recordValue(row.content)?.data);
          if (!event.success || event.data.type !== 'worker-report'
            || !workerDeliverablesBelongToSessionV1(event.data.deliverables, observation.sourceSessionId)) {
            return { ...buildUnavailableEnvelope({ observation, awareness }), sourceRecencyMs };
          }
          publishedReport = { text: event.data.summary, seq: row.seq,
            ...(event.data.deliverables ? { deliverables: event.data.deliverables } : {}) };
        }
        const decoded = isManager || selectsVoiceOriginals
          ? decodeTranscriptBody({ role: row.role, content: row.content, meta: row.meta }) : null;
        if (observation.relation === 'manager') {
          if (decoded && !decoded.sidechainId) {
            for (const call of decoded.toolCalls ?? []) {
              const name = call.name.startsWith('mcp__happier__') ? call.name.slice('mcp__happier__'.length) : call.name;
              const generic = recordValue(call.input);
              const input = name === 'action_execute' && generic?.actionId === 'session.message.send' ? generic.input
                : name === 'session_message_send' ? call.input : undefined;
              const parsed = getActionSpec('session.message.send').inputSchema.safeParse(input);
              const request = parsed.success ? recordValue(parsed.data) : null;
              if (request && typeof request.sessionId === 'string' && typeof request.message === 'string' && request.recipient === undefined) {
                const send = { target: request.sessionId, message: request.message, seq: row.seq };
                outgoingCalls.set(call.callId, send);
                lastOutgoingSend = { ...send, accepted: false };
              }
            }
            for (const result of decoded.toolResults ?? []) {
              const send = outgoingCalls.get(result.callId);
              if (send && lastOutgoingSend?.seq === send.seq) {
                lastOutgoingSend = { ...send, accepted: !result.isError && isAcceptedCrossSessionSendOutput(result.output) };
              }
            }
          }
          if (decoded?.semanticRole === 'assistant' && decoded.text && !decoded.sidechainId) {
            workerText = { text: decoded.text, seq: row.seq, ...(decoded.provider ? { agentId: decoded.provider } : {}) };
          }
        }
        const voiceOriginal = selectsVoiceOriginals;
        const projected = projectOpenedSessionFollowRow(row, !input.disclosure, voiceOriginal ? observation.sourceSessionId : undefined);
        const content = recordValue(row.content);
        const semanticBody = content?.type === 'acp' || content?.type === 'codex' ? recordValue(content.data) : content;
        const sourceSidechain = row.sidechainId || decoded?.sidechainId;
        if (voiceOriginal && !sourceSidechain && content?.type === 'event'
          && recordValue(content.data)?.type === 'worker-report' && projected.summary === null) {
          return { ...buildUnavailableEnvelope({ observation, awareness }), sourceRecencyMs };
        }
        const originalEvent = sourceSidechain ? null : projected.summary && isAuthoritativeHumanSessionFollowMessageV1(projected.summary)
          ? { kind: 'person_wrote' as const }
          : row.role === 'agent' && semanticBody && typeof semanticBody.type === 'string' && !decoded?.sidechainId
            ? readSessionFollowSemanticSourceEvent({ ...semanticBody, type: semanticBody.type })
              ?? (voiceOriginal && content?.type === 'text' ? { kind: 'message' as const } : null)
            : null;
        // A manager's optional Turn fact cannot consume a selected transcript
        // original before its admitted input exists. Keep that prefix pending
        // even when admission failed and there is no queued input to expose it.
        // Account Voice retains its independent original-reader lifetime.
        if (isManager && !input.disclosure && !('kind' in observation) && originalEvent
          && observation.policy && resolveFollowDeliveryV1({ policies: [observation.policy], event: originalEvent }).selected
          && SessionFollowSourceMessageV1Schema.safeParse({ localId: storedRow.localId, seq: row.seq }).success) {
          omittedObservedMessage = true;
          break;
        }
        const selected = !voiceOriginal || originalEvent !== null
          && observation.policy !== undefined
          && resolveFollowDeliveryV1({ policies: [observation.policy], event: originalEvent }).person.voice;
        if (selected && projected.summary && !isManager) {
          summaries.push(projected.summary);
          summaryIsUserMessage.push(projected.userMessage);
          consumedThroughByRenderedMessageCount.push(row.seq);
        } else {
          // Non-renderable rows and manager-only progress between reports are
          // consumed by original traversal without copying them into a card.
          consumedThroughByRenderedMessageCount[consumedThroughByRenderedMessageCount.length - 1] = row.seq;
        }
        nextContiguousSeq = row.seq + 1;
        if (isManager && nextContiguousSeq <= observedSeq && rowIndex === rows.length - 1 && pageHasMore) {
          signal.throwIfAborted();
          try {
            const next = useRunnerProjection ? await fetchRunnerPage(row.seq) : await fetchAccountPageAfter(row.seq);
            if (!next || (useRunnerProjection && 'source' in next && next.source.id !== observation.sourceSessionId)) {
              omittedObservedMessage = true;
              break;
            }
            rows = [...next.messages];
            pageHasMore = next.hasMore;
            rowIndex = -1;
          } catch {
            omittedObservedMessage = true;
            break;
          }
        }
      }

      const consumedTranscriptSeq = consumedThroughByRenderedMessageCount[
        consumedThroughByRenderedMessageCount.length - 1
      ] ?? deliveredSeq;
      reachedObservedTranscript = consumedTranscriptSeq === observedSeq;
      if (readMode === 'initial_current_snapshot' && consumedTranscriptSeq !== observedSeq) {
        // A current snapshot is useful only when the bounded window reaches the
        // exact observed cap. Missing, malformed, or unavailable tail material
        // must not turn an approximate read into a durable baseline ACK.
        return { ...buildUnavailableEnvelope({ observation, awareness }), sourceRecencyMs };
      }
      if (consumedTranscriptSeq === traversalBaseline && consumedTranscriptSeq < observedSeq) {
        // A gap at the first pending row admits no transcript prefix. Keep the
        // whole observation retryable; later rows must never be scanned around
        // the unreadable or mode-incompatible sequence.
        return { ...buildUnavailableEnvelope({ observation, awareness }), sourceRecencyMs };
      }

      // Wake discovery (09D §6.3): the pending range, not only this page, decides
      // whether protected human ingress exists. Later pages are classified with the
      // same row projection but never delivered or acknowledged here; delivery stays
      // the oldest contiguous prefix above. A gap or unopenable row stops discovery
      // exactly as it stops delivery, so nothing is scanned around unreadable rows.
      let pendingHumanIngress: boolean | undefined;
      if (discoverHumanIngress) {
        pendingHumanIngress = summaries.some(isAuthoritativeHumanSessionFollowMessageV1);
        let cursor = consumedTranscriptSeq;
        let hasMore = pageHasMore && !omittedObservedMessage && readMode === 'incremental';
        while (!pendingHumanIngress && hasMore && cursor < observedSeq) {
          signal.throwIfAborted();
          let next: Readonly<{ messages: typeof rows; hasMore: boolean }>;
          try {
            if (useRunnerProjection) {
              const projection = await fetchRunnerPage(cursor);
              if (!projection || projection.source.id !== observation.sourceSessionId) break;
              next = projection;
            } else {
              next = await fetchAccountPageAfter(cursor);
            }
          } catch {
            break;
          }
          let advanced = false;
          let stopped = false;
          for (const storedRow of next.messages) {
            const storedSeq = typeof storedRow.seq === 'number' && Number.isSafeInteger(storedRow.seq)
              ? storedRow.seq
              : null;
            if (storedSeq !== null && storedSeq <= cursor) continue;
            if (storedSeq === null || storedSeq > observedSeq || storedSeq !== cursor + 1) {
              stopped = true;
              break;
            }
            const opened = openSessionFollowTranscriptRow({ mode, ctx, row: storedRow });
            if (!opened.ok) {
              stopped = true;
              break;
            }
            const projected = projectOpenedSessionFollowRow(opened.row, !input.disclosure);
            cursor = storedSeq;
            advanced = true;
            if (projected.summary && isAuthoritativeHumanSessionFollowMessageV1(projected.summary)) {
              pendingHumanIngress = true;
              break;
            }
          }
          hasMore = !stopped && advanced && next.hasMore;
        }
      }

      // Legacy/current snapshots keep the newest context. Modern incremental
      // originals keep the oldest selected prefix; a snippet allowance must not
      // acknowledge a later report over an earlier unrepresented original.
      let disclosedSummaries = summaries;
      let disclosedCheckpoints = consumedThroughByRenderedMessageCount;
      if (input.disclosure && mayQuoteSourceMessages) {
        const disclosure = input.disclosure;
        const permitted = summaries.filter((_summary, index) => (
          disclosure.includeUserMessagesInSnippets || !summaryIsUserMessage[index]
        ));
        disclosedSummaries = selectsVoiceOriginals ? permitted.slice(0, disclosure.snippetsMaxMessages)
          : permitted.slice(-disclosure.snippetsMaxMessages);
        const firstDeferred = selectsVoiceOriginals ? permitted[disclosure.snippetsMaxMessages] : undefined;
        const representedThrough = firstDeferred
          ? consumedThroughByRenderedMessageCount[summaries.indexOf(firstDeferred)]!
          : consumedTranscriptSeq;
        disclosedCheckpoints = disclosedSummaries.length === 0
          ? [representedThrough]
          : [
              ...disclosedSummaries.map((summary) => selectsVoiceOriginals
                ? consumedThroughByRenderedMessageCount[summaries.indexOf(summary)]! : summary.seq - 1),
              representedThrough,
            ];
      }

      if (selectsVoiceOriginals && summaries.length === 0 && !selectedVoiceTurn && selectedVoiceRequests.length === 0) return null;
      return {
        v: 1,
        kind: 'session_follow_update',
        edge: {
          sourceSessionId: observation.sourceSessionId,
          destinationSessionId: observation.destinationSessionId,
        },
        reason: 'source_changed',
        deliveryIntent: 'context_only',
        observed: readMode === 'initial_current_snapshot'
          ? observation.observed
          : {
              ...observation.observed,
              transcriptSeq: selectsVoiceOriginals && mayQuoteSourceMessages ? disclosedCheckpoints.at(-1)! : consumedTranscriptSeq,
              ...(isManager && !reachedObservedTranscript ? { turn: observation.delivered.turn } : {}),
            },
        awareness: projectDisclosedAwareness(awareness),
        recentMessages: mayQuoteSourceMessages ? disclosedSummaries : [],
        ...(questionOffers?.length ? { questionOffers } : {}),
        truncated: pageHasMore
          || selectsVoiceOriginals && disclosedCheckpoints.at(-1)! < consumedTranscriptSeq
          || traversalBaseline > deliveredSeq
          || consumedTranscriptSeq < observedSeq
          || omittedObservedMessage,
        sourceRecencyMs,
        transcriptConsumedThroughByRenderedMessageCount: Object.freeze(
          mayQuoteSourceMessages
            ? [...disclosedCheckpoints]
            // Nothing was quoted, so the one checkpoint is the exact contiguous
            // frontier this read represents.
            : [consumedTranscriptSeq],
        ),
        ...(pendingHumanIngress !== undefined ? { pendingHumanIngress } : {}),
        ...(composeWorkerUpdate() ? { workerUpdate: composeWorkerUpdate() } : {}),
        ...(reachedObservedTranscript ? workerAdmission : {}),
      };
    } finally {
      if (preparedMaterial?.mode === 'e2ee') preparedMaterial.dataKey.fill(0);
    }
  };
}
