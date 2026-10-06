import { isAxiosError } from 'axios';

import type {
  SessionAwarenessProjectionV1,
  SessionFollowPendingObservationV1,
  SessionFollowUpdateEnvelopeV1,
  WorkerUpdateV1,
  VoiceSessionUpdatePolicyV1,
  VoiceSourceDisclosureV1,
} from '@happier-dev/protocol';
import { composeWorkflowRunWorkerUpdateV1 } from '@happier-dev/protocol/workflows/composeWorkflowRunWorkerUpdateV1';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, openWorkflowFinalResultStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { resolveWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';
import { WorkflowLoopOutcomeV1Schema, WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { isAuthoritativeHumanSessionFollowMessageV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowUpdateEnvelopeV1';
import { isSessionFollowTurnEqualV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { resolveVoiceSessionUpdatePolicyV1, resolveVoiceSourceDisclosureV1 } from '@happier-dev/protocol/voice/sourceDisclosureV1';
import { parseSessionMessageAccountActorV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { readSessionMessageProvenanceV1, SessionInputAdmissionResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { TranscriptRawAgentEventV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { WorkerUpdateV1Schema, workerDeliverablesBelongToSessionV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { StoredCredentials } from '@/persistence';
import {
  projectCliSessionAwarenessFromMaterialV1,
  projectCliSessionAwarenessUnavailableMaterialV1,
  projectCliSessionAwarenessV1,
} from '@/cli/output/session/sessionAwareness';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { decodeTranscriptBody } from '@/session/services/transcript/transcriptBodyDecoder';
import {
  openSessionStoredContent,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  resolveSessionTransportContextFromMaterial,
  type SessionEncryptionContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { fetchSessionFollowSourceProjection } from '@/session/transport/http/sessionFollowSourceProjectionHttp';
import { createWorkflowRunStorageClient } from '@/daemon/workflows/workflowRunStorageClient';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import {
  createAutomationAccountEncryptionMaterialSnapshotV1,
  resolveValidatedAutomationAccountEncryptionV1,
} from '@/plugins/runtime/automations/automationAccountCurrentness';

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
  /** Reports-to uses the same authorized hydration, but renders the owning worker outcome. */
  workerUpdate?: WorkerUpdateV1;
  /** Run grants are independent of the source Session grant rechecked by Follow. */
  recheckWorkerUpdateAdmission?: (signal: AbortSignal) => Promise<boolean>;
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
}>;

type SessionFollowTranscriptRowOpenResult =
  | Readonly<{ ok: true; row: SessionFollowOpenedTranscriptRow }>
  | Readonly<{ ok: false; reason: 'invalid_row' | 'content_unavailable' }>;

function recordValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

/** Read FIN's committed outcome under the lead's own Run grant, within the Follow Home context. */
async function readCurrentReviewWorkerUpdate(input: Readonly<{
  credentials: StoredCredentials;
  observation: SessionFollowPendingObservationV1;
  signal: AbortSignal;
}>): Promise<WorkerUpdateV1 | null> {
  const { observation, signal, credentials } = input;
  if (observation.observed.turn?.status !== 'completed') return null;
  const storage = createWorkflowRunStorageClient({ token: credentials.token });
  const reviewFiringAt = (run: ReturnType<typeof WorkflowRunSummaryV1Schema.parse>) => {
    const cause = run.origin.kind === 'automation' ? run.origin.cause : undefined;
    return run.origin.originSessionId === observation.sourceSessionId
      && cause?.kind === 'trigger' && cause.triggerKind === 'sessionLifecycle'
      && cause.evidence.event === 'parentTurnCompleted'
      && cause.evidence.sourceSessionId === observation.sourceSessionId
      ? cause.occurredAt : null;
  };
  // Verify/fix steps advance the provider turn, not the review's immutable firing
  // cause. Select the latest review firing, including non-exhausted outcomes, so
  // a historical exhausted result cannot override a newer completed review.
  let latestReview: Readonly<{ occurredAt: number; update: WorkerUpdateV1 | null }> | null = null;
  let cursor: string | undefined;
  do {
    let page: Readonly<Record<string, unknown>> | null;
    try {
      page = recordValue(await storage.execute({ operation: 'list',
        request: { originSessionId: observation.sourceSessionId, ...(cursor ? { cursor } : {}) },
        pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES }, { signal }));
    } catch (error) {
      if (isAxiosError(error) && (error.response?.status === 403 || error.response?.status === 404)) return null;
      throw error;
    }
    if (!page) throw new Error('workflow_delivery_response_invalid');
    for (const run of WorkflowRunSummaryV1Schema.array().parse(page.runs)) {
      const firingAt = reviewFiringAt(run);
      if (firingAt === null || (latestReview && firingAt < latestReview.occurredAt)) continue;
      let raw: Readonly<Record<string, unknown>> | null;
      try {
        raw = recordValue(await storage.execute({ operation: 'get', runId: run.id }, { signal }));
      } catch (error) {
        // A Session grant is never a Run grant; revoked/inaccessible outcomes disclose nothing.
        if (isAxiosError(error) && (error.response?.status === 403 || error.response?.status === 404)) continue;
        throw error;
      }
      if (!raw) throw new Error('workflow_delivery_response_invalid');
      const current = WorkflowRunSummaryV1Schema.parse(raw.run);
      const currentFiringAt = reviewFiringAt(current);
      if (current.id !== run.id || currentFiringAt === null
        || (latestReview && currentFiringAt < latestReview.occurredAt)) continue;
      const census = WorkflowRunRecipientCensusResponseV1Schema.parse(raw.keyCensus);
      if (census.runId !== run.id || (current.ownerAccountId !== undefined && current.ownerAccountId !== census.ownerAccountId)) {
        throw new Error('workflow_delivery_binding_mismatch');
      }
      const accountEncryption = await resolveValidatedAutomationAccountEncryptionV1({ signal,
        resolveAccountEncryptionCurrentness: (currentnessSignal) => fetchAccountEncryptionCurrentness({ token: credentials.token, signal: currentnessSignal }),
        resolveAccountEncryptionMaterial: async () => createAutomationAccountEncryptionMaterialSnapshotV1(credentials),
      });
      if (accountEncryption.kind !== 'available') continue;
      const resolved = resolveWorkflowRunDataKeyV1({ encryption: accountEncryption, census });
      if (resolved.kind !== 'available') continue;
      const binding = { v: 1 as const, accountId: census.ownerAccountId, runId: run.id };
      const accepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...resolved.encryption.runCrypto,
        binding: { ...binding, purpose: 'accepted_snapshot' }, envelope: parseWorkflowStoredContentEnvelopeV1(raw.acceptedEnvelope) });
      if (accepted.kind !== 'available') continue;
      if (accepted.content.origin?.originSessionId !== observation.sourceSessionId
        || accepted.content.machineId !== current.machineId
        || accepted.content.source.kind !== 'catalog' || accepted.content.source.ref !== 'builtin:review-and-converge') continue;
      if (!latestReview || currentFiringAt > latestReview.occurredAt) latestReview = { occurredAt: currentFiringAt, update: null };
      if (current.state !== 'succeeded') continue;
      if (raw.resultEnvelope == null) continue;
      const final = openWorkflowFinalResultStoredEnvelopeV1({ ...resolved.encryption.runCrypto,
        binding: { ...binding, purpose: 'final_result' }, envelope: parseWorkflowStoredContentEnvelopeV1(raw.resultEnvelope) });
      if (final.kind !== 'available' || final.content.result.kind !== 'json') continue;
      const outcome = WorkflowLoopOutcomeV1Schema.safeParse(final.content.result.value);
      if (!outcome.success || outcome.data.kind !== 'exhausted') continue;
      const update = composeWorkflowRunWorkerUpdateV1({ run: current, finalResult: final.content });
      latestReview = { occurredAt: currentFiringAt,
        update: update ? { ...update, wake: 'needs_you', headline: "Review didn't converge" } : null };
    }
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
  } while (cursor && !signal.aborted);
  signal.throwIfAborted();
  return latestReview?.update ?? null;
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
function projectOpenedSessionFollowRow(row: SessionFollowOpenedTranscriptRow): Readonly<{
  summary: SessionFollowRowSummary | null;
  userMessage: boolean;
}> {
  const decoded = decodeTranscriptBody({ role: row.role, content: row.content, meta: row.meta });
  const semanticText = decoded?.text ?? decoded?.summary;
  if (!semanticText || semanticText.trim().length === 0) return { summary: null, userMessage: false };
  const authorLabel = readAuthorLabel(row.accountActor);
  return {
    summary: {
      messageId: `seq:${row.seq}`,
      seq: row.seq,
      text: semanticText,
      ...(authorLabel ? { authorLabel } : {}),
      provenance: readSessionMessageProvenanceV1(row.meta),
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

  return async ({ observation, signal, readMode = 'incremental', discoverHumanIngress = false }) => {
    signal.throwIfAborted();
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
    const fetchRunnerPage = async (afterTranscriptSeq: number) => await input.session.runSessionFollowSourceRequest({
      credentials: input.credentials,
      request: async () => await fetchRunnerProjection({
        token: input.credentials.token,
        destinationSessionId,
        sourceSessionId: observation.sourceSessionId,
        ...(observation.edgeKind ? { edgeKind: observation.edgeKind, attachedAt: observation.attachedAt,
          readMode } : {}),
        afterTranscriptSeq,
        observedTranscriptSeq: observation.observed.transcriptSeq,
        limit: SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1,
        signal,
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
    // Account Voice's independent initial snapshot is still unsupported here;
    // reports-to reads select the same transport owner with exact attachment evidence.
    if (readMode === 'initial_current_snapshot' && useRunnerProjection && observation.edgeKind !== 'reports_to') return null;
    const runnerProjection = useRunnerProjection
      ? await fetchRunnerPage(readMode === 'initial_current_snapshot' ? 0 : observation.delivered.transcriptSeq).catch(() => null)
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
          request: async () => await resolveTransport({
            credentials: input.credentials,
            idOrPrefix: observation.sourceSessionId,
            ...(signal ? { signal } : {}),
          }),
        });
      }
    } catch {
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
      const workerState = observation.edgeKind === 'reports_to'
        ? awareness.lifecycle === 'failed' ? 'failed'
          : awareness.lifecycle === 'cancelled' ? 'cancelled'
            : awareness.lifecycle === 'ready' && observation.observed.turn?.status === 'completed' && pendingReviewRuns === 0 ? 'settled'
              : awareness.operational.primary === 'permission_required' || awareness.operational.primary === 'action_required' ? 'needs_input'
                : observation.observed.turn?.status === 'stalled'
                  && !isSessionFollowTurnEqualV1(observation.delivered.turn, observation.observed.turn) ? 'stalled' : null
        : null;
      let workerText: Readonly<{ text: string; seq: number; agentId?: string }> | null = null;
      let publishedReport: Readonly<{ text: string; seq: number; deliverables?: WorkerUpdateV1['deliverables'] }> | null = null;
      const reviewWorkerUpdate = observation.edgeKind === 'reports_to' && workerState === 'settled'
        && isSessionAwarenessContentReadableV1(awareness.encryption)
        ? await input.session.runSessionFollowSourceRequest({ credentials: input.credentials,
            request: () => readCurrentReviewWorkerUpdate({ credentials: input.credentials, observation, signal }) })
        : null;
      const reviewAdmission = reviewWorkerUpdate ? {
        recheckWorkerUpdateAdmission: async (recheckSignal: AbortSignal) => {
          try {
            const current = await input.session.runSessionFollowSourceRequest({ credentials: input.credentials,
              request: () => readCurrentReviewWorkerUpdate({ credentials: input.credentials, observation, signal: recheckSignal }) });
            return !recheckSignal.aborted && current !== null
              && JSON.stringify(current) === JSON.stringify(reviewWorkerUpdate);
          } catch {
            return false;
          }
        },
      } : {};
      const outgoingCalls = new Map<string, Readonly<{ target: string; message: string; seq: number }>>();
      let lastOutgoingSend: Readonly<{ target: string; message: string; seq: number; accepted: boolean }> | null = null;
      const composeWorkerUpdate = (): WorkerUpdateV1 | undefined => {
        if (observation.edgeKind !== 'reports_to') return undefined;
        if (reviewWorkerUpdate) return WorkerUpdateV1Schema.parse(reviewWorkerUpdate);
        const ownerState = publishedReport ? 'published' : workerState;
        if (!ownerState) return undefined;
        const repeatedFinalText = !publishedReport && workerText && lastOutgoingSend?.accepted
          && lastOutgoingSend.target === observation.destinationSessionId && lastOutgoingSend.message.includes(workerText.text);
        const result = publishedReport ?? (repeatedFinalText ? null : workerText);
        const headline = `${awareness.title ?? observation.sourceSessionId} · ${ownerState}`;
        return WorkerUpdateV1Schema.parse({
          v: 1, workerKind: 'session', workerId: observation.sourceSessionId, ownerState,
          wake: ownerState === 'published' ? 'published' : ownerState === 'stalled' ? 'stalled'
            : ownerState === 'failed' || ownerState === 'needs_input' ? 'needs_you' : 'finished',
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

      const deliveredSeq = observation.delivered.transcriptSeq;
      const observedSeq = observation.observed.transcriptSeq;
      if (observedSeq <= deliveredSeq && observation.edgeKind !== 'reports_to') {
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
          truncated: false,
          sourceRecencyMs,
          transcriptConsumedThroughByRenderedMessageCount: [deliveredSeq],
          ...(composeWorkerUpdate() ? { workerUpdate: composeWorkerUpdate() } : {}),
          ...reviewAdmission,
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
      } catch {
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
      for (const storedRow of rows) {
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
        if (observation.edgeKind === 'reports_to') {
          const decoded = decodeTranscriptBody({ role: row.role, content: row.content, meta: row.meta });
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
          if (row.content && typeof row.content === 'object' && !Array.isArray(row.content)
            && 'type' in row.content && row.content.type === 'event' && 'data' in row.content) {
            const event = TranscriptRawAgentEventV1Schema.safeParse(row.content.data);
            if (event.success && event.data.type === 'worker-report' && row.seq > deliveredSeq
              && workerDeliverablesBelongToSessionV1(event.data.deliverables, observation.sourceSessionId)) {
              publishedReport = { text: event.data.summary, seq: row.seq, ...(event.data.deliverables ? { deliverables: event.data.deliverables } : {}) };
            }
          }
        }
        const projected = projectOpenedSessionFollowRow(row);
        if (projected.summary) {
          summaries.push(projected.summary);
          summaryIsUserMessage.push(projected.userMessage);
          consumedThroughByRenderedMessageCount.push(row.seq);
        } else {
          // The Protocol semantic projector deliberately returns no text for
          // valid events that have no useful model-visible representation.
          // They are consumed by traversal, not invented into prompt prose.
          consumedThroughByRenderedMessageCount[consumedThroughByRenderedMessageCount.length - 1] = row.seq;
        }
        nextContiguousSeq = row.seq + 1;
      }

      const consumedTranscriptSeq = consumedThroughByRenderedMessageCount[
        consumedThroughByRenderedMessageCount.length - 1
      ] ?? deliveredSeq;
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
            const projected = projectOpenedSessionFollowRow(opened.row);
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

      // Account Voice snippet controls, exactly as the foreground path applies them:
      // the user's own messages only when explicitly shared, and only the Account's
      // newest represented messages. Withheld rows are a deliberate disclosure
      // decision, so they are consumed by traversal and settle with the represented
      // frontier instead of replaying every Voice turn.
      let disclosedSummaries = summaries;
      let disclosedCheckpoints = consumedThroughByRenderedMessageCount;
      if (input.disclosure && mayQuoteSourceMessages) {
        const disclosure = input.disclosure;
        const permitted = summaries.filter((_summary, index) => (
          disclosure.includeUserMessagesInSnippets || !summaryIsUserMessage[index]
        ));
        disclosedSummaries = permitted.slice(-disclosure.snippetsMaxMessages);
        disclosedCheckpoints = disclosedSummaries.length === 0
          ? [consumedTranscriptSeq]
          : [
              ...disclosedSummaries.map((summary) => summary.seq - 1),
              consumedTranscriptSeq,
            ];
      }

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
              transcriptSeq: consumedTranscriptSeq,
            },
        awareness: projectDisclosedAwareness(awareness),
        recentMessages: mayQuoteSourceMessages ? disclosedSummaries : [],
        truncated: pageHasMore
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
        ...reviewAdmission,
      };
    } finally {
      if (preparedMaterial?.mode === 'e2ee') preparedMaterial.dataKey.fill(0);
    }
  };
}
