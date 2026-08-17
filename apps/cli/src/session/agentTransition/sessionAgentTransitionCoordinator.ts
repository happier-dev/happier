import {
  SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
  beginSessionAgentTransitionEffects,
  buildSessionAgentTransitionDividerLocalId,
  readPendingLocalId,
  readDisplayableSessionWorkStateV1,
  readSessionAgentTransitionDividerV1,
  rejectUndispatchedSessionAgentTransition,
  sanitizeSessionUserMessageSendMeta,
  type SessionAgentTransitionCurrentViewCommitted,
  type SessionAgentTransitionRequestV1,
  type SessionAgentTransitionResultV1,
  type SessionAgentTransitionSourceUntouched,
  type SessionStoredMessageContent,
} from '@happier-dev/protocol';
import {
  projectCurrentAgentSessionView,
  resolveAgentIdFromSessionMetadata,
  resolvePermissionIntentFromSessionMetadata,
  type AgentId,
} from '@happier-dev/agents';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { findTranscriptEncryptedMessageByLocalIdV2 } from '@/api/session/transcriptMessageLookup';
import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { resolveTrustedSessionAttachmentLocalImagePaths } from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';
import { resolveReplaySeedDraft, type ReplaySeedDraftResolution } from '@/session/replay/resolveReplaySeedDraft';
import { admitSessionUserMessageToPendingQueue } from '@/session/services/admitSessionUserMessage';
import { requestInactiveSessionResume } from '@/session/services/requestInactiveSessionResume';
import { requestSessionStop } from '@/session/services/requestSessionStop';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { waitForSessionIdle } from '@/session/services/waitForSessionIdle';
import {
  decryptStoredSessionPayload,
  encryptSessionPayload,
  encryptStoredSessionPayload,
  tryDecryptSessionMetadata,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { commitSessionAgentTransitionCutover } from '@/session/transport/http/sessionAgentTransitionHttp';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { resolveSessionControlStopTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { logger } from '@/ui/logger';

import {
  hasCanonicalHostedTranscript,
  resolveSessionContinuationTargetAgent,
} from './sessionContinuationInspection';

/**
 * Same-Session cross-Agent continuation — the predecessor (minimum) vertical.
 *
 *   strict idle -> confirmed stop -> target current-view commit -> divider
 *   -> exact input into Pending custody -> fresh target activation
 *
 * The target is ALWAYS fresh here. This tree stores no machine-local native
 * resume record, so there is nothing to return to; the source Agent's flat
 * resume key is dropped by the current-view projector and the target starts
 * from a bounded Replay brief carried in `metadata.replaySeedV1`, which the
 * existing seed owner prefixes onto the first provider-accepted prompt.
 *
 * Two orderings differ from a naive reading of the design, and both are
 * deliberate predecessor contracts:
 *
 * 1. There is no epoch-scoped input-admission fence. `SessionProviderInputConsumer`
 *    has a one-way close latch and no reopen, so an epoch subsystem would be new
 *    machinery, not reuse. Strict idle is rechecked immediately before the stop
 *    instead; a final ordinary prompt that wins that instant begins and is then
 *    interrupted by the normal stop path.
 * 2. Input custody is taken BEFORE the target is started, because that is this
 *    tree's invariant at `sendSessionMessage`: starting a runtime with no
 *    durable Pending row creates work the user cannot recover. `accepted`
 *    therefore means canonical admission plus a started target, and a failure
 *    after admission is reported as `target_start_failed` rather than silently
 *    dropping the message.
 *
 * Every result reachable after the confirmed stop rides `partially_applied` or
 * `outcome_unknown`. `rejected` is used only where the source is provably still
 * running, because that arm's `sourceEffect: 'none'` is a promise the UI turns
 * into a keep-editing action.
 */

export type SessionAgentTransitionCoordinatorDeps = Readonly<{
  /** Bounded quiescence window before the stop. Defaults to the session-control stop budget. */
  idleTimeoutMs?: number;
  now?: () => number;
}>;

// Result arms are built ONLY through the effect-stage handle threaded down the
// flow (`beginSessionAgentTransitionEffects`, in the Protocol package beside the
// result union). The handle in scope is the proof of the depth reached: after
// the confirmed stop, `rejected` does not exist on it, so the arm-guarantee
// class stops being something each exit site has to get right.

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function buildDividerContent(params: Readonly<{
  mode: 'plain' | 'e2ee';
  ctx: Parameters<typeof encryptSessionPayload>[0]['ctx'];
  dividerLocalId: string;
  fromAgentId: string;
  toAgentId: string;
}>): SessionStoredMessageContent {
  const payload = {
    role: 'agent',
    content: {
      type: 'event',
      id: params.dividerLocalId,
      data: {
        type: 'message',
        message: SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
        sessionAgentTransitionV1: {
          v: 1,
          fromAgentId: params.fromAgentId,
          toAgentId: params.toAgentId,
        },
      },
    },
  };
  if (params.mode === 'plain') {
    return { t: 'plain', v: payload };
  }
  return {
    t: 'encrypted',
    // Deterministic by localId so a retry re-derives byte-identical content and
    // the message owner reconciles it as the same row instead of overwriting it.
    c: encryptSessionPayload({ ctx: params.ctx, payload, idempotencyKey: params.dividerLocalId }),
  };
}

/**
 * Section 7.4, from a committed target current view onward.
 *
 * Shared by the first pass and by a retry that finds the cutover already
 * committed, so activation and admission have exactly ONE implementation. Input
 * custody is taken before activation because that is this tree's
 * `sendSessionMessage` invariant: starting a runtime with no durable Pending row
 * behind it creates work the user cannot recover.
 */
async function admitInputAndActivateTarget(params: Readonly<{
  credentials: Credentials;
  request: SessionAgentTransitionRequestV1;
  localId: string;
  mode: SessionStoredContentEncryptionMode;
  ctx: Parameters<typeof encryptSessionPayload>[0]['ctx'];
  sanitizedMeta: ReturnType<typeof sanitizeSessionUserMessageSendMeta>;
  /** The committed target current view — the source of permission intent and the resume basis. */
  targetMetadata: Record<string, unknown>;
  /** Proof that the target current view is committed; the source of every arm here. */
  committed: SessionAgentTransitionCurrentViewCommitted;
}>): Promise<SessionAgentTransitionResultV1> {
  const { committed, localId, request } = params;

  // Permission intent is Session-global safety intent, carried across the
  // transition rather than reset. `default` is the same fallback the ordinary
  // send path uses when metadata declares none.
  const permissionIntent = resolvePermissionIntentFromSessionMetadata(params.targetMetadata)?.intent ?? 'default';
  const admission = await admitSessionUserMessageToPendingQueue({
    credentials: params.credentials,
    sessionId: request.sessionId,
    mode: params.mode,
    ctx: params.ctx,
    localId,
    text: request.input.text,
    meta: params.sanitizedMeta,
    permissionIntent,
    ...(request.selection.modelId ? { modelId: request.selection.modelId } : {}),
  });
  if (admission.status === 'unconfirmed') {
    return committed.committed('input_admission_failed');
  }
  if (admission.status === 'suppressed') {
    return committed.committed('input_rejected');
  }

  // Refetch the committed row before activation. Its `seq` now includes the
  // divider, so the started target catches up from the boundary rather than
  // replaying the source's turns, and its `active`/`archivedAt` are re-proven
  // against the row the cutover actually wrote.
  const committedSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: request.sessionId,
  }).catch((error: unknown) => {
    if (isAuthenticationError(error)) throw error;
    return null;
  });
  if (!committedSession) return committed.committed('target_start_failed');

  // Activation is for an INACTIVE target only. The first pass always reaches
  // here inactive, because the cutover refuses an active Session — but the
  // reconcile path does not: its likeliest cause is a retry after an invocation
  // that fully succeeded and lost only its answer, so the target is already
  // running. `requestInactiveSessionResume` carries no active guard of its own
  // and goes straight to the machine SPAWN RPC, so calling it there would issue
  // a lifecycle action against a live runtime and, if the daemon refuses, would
  // report a completed transition as `target_start_failed`.
  if (committedSession.active !== true) {
    const resumed = await requestInactiveSessionResume({
      credentials: params.credentials,
      sessionId: request.sessionId,
      localId,
      rawSession: committedSession,
      metadata: params.targetMetadata,
    });
    if (!resumed.ok) {
      logger.debug('[AGENT TRANSITION] Target activation failed', { code: resumed.code, message: resumed.message });
      return committed.committed('target_start_failed');
    }
  }

  return committed.accepted();
}

type DividerEvidence =
  | Readonly<{ status: 'present'; matches: boolean }>
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'unknown' }>;

/**
 * The stored-record shape a row MUST have before this daemon will call it the
 * transition's own divider.
 *
 * `readSessionAgentTransitionDividerV1` reads the agent-event PAYLOAD; on its
 * own it says nothing about the record carrying that payload. The divider is
 * always written as a `role:'agent'` / `content.type:'event'` record, so a
 * user-role (or non-event) row planted at the reserved localId with a matching
 * sidecar must never be read as ours.
 */
function readTransitionDividerFromStoredRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { role?: unknown; content?: unknown };
  if (record.role !== 'agent') return null;
  const content = record.content as { type?: unknown; data?: unknown } | undefined;
  if (!content || content.type !== 'event') return null;
  return readSessionAgentTransitionDividerV1(content.data);
}

async function readDividerEvidence(params: Readonly<{
  token: string;
  sessionId: string;
  dividerLocalId: string;
  mode: SessionStoredContentEncryptionMode;
  ctx: Parameters<typeof encryptSessionPayload>[0]['ctx'];
  expected: Readonly<{ fromAgentId: string; toAgentId: string }>;
}>): Promise<DividerEvidence> {
  const outcome = await findTranscriptEncryptedMessageByLocalIdV2({
    token: params.token,
    serverUrl: resolveServerHttpBaseUrl(),
    sessionId: params.sessionId,
    localId: params.dividerLocalId,
  }).catch(() => ({ type: 'protocol_error' as const, error: null }));

  if (outcome.type === 'not_found') return { status: 'absent' };
  if (outcome.type !== 'found') return { status: 'unknown' };

  const content = outcome.message.content as Readonly<{ t?: unknown; c?: unknown; v?: unknown }>;
  let record: unknown;
  try {
    record = content.t === 'encrypted'
      ? decryptStoredSessionPayload({ mode: params.mode, ctx: params.ctx, value: String(content.c ?? '') })
      : content.v;
  } catch {
    return { status: 'unknown' };
  }
  const divider = readTransitionDividerFromStoredRecord(record);
  if (!divider) return { status: 'unknown' };
  return {
    status: 'present',
    matches: divider.fromAgentId === params.expected.fromAgentId
      && divider.toAgentId === params.expected.toAgentId,
  };
}

/**
 * Section 7.5. The Session already names the TARGET Agent, so this invocation is
 * a reconciliation of an operation whose cutover already committed — not a
 * second switch, and above all not a stale client view.
 *
 * Reporting `rejected('stale_selection')` here would assert `sourceEffect:
 * 'none'` while the source is confirmed stopped and the current view committed,
 * and the UI turns that promise into a Keep-editing action in front of a dead
 * runtime. The divider and the submitted localId are the only evidence that
 * exists; no marker or receipt was ever persisted.
 */
async function reconcileAlreadyTargetedSession(params: Readonly<{
  credentials: Credentials;
  request: SessionAgentTransitionRequestV1;
  localId: string;
  mode: SessionStoredContentEncryptionMode;
  ctx: Parameters<typeof encryptSessionPayload>[0]['ctx'];
  workspacePath: string;
  committedMetadata: Record<string, unknown>;
  targetAgentId: AgentId;
  effects: SessionAgentTransitionSourceUntouched;
}>): Promise<SessionAgentTransitionResultV1> {
  const { localId, request } = params;
  // The Session already NAMES the target, which is this operation's own cutover
  // seen again, so the depth advances on that observation before any arm is
  // built here. A rejection from this branch would promise an untouched source
  // in front of an already-committed Session.
  const committed = params.effects.cutoverObservedCommitted();
  const divider = await readDividerEvidence({
    token: params.credentials.token,
    sessionId: request.sessionId,
    dividerLocalId: buildSessionAgentTransitionDividerLocalId(localId),
    mode: params.mode,
    ctx: params.ctx,
    expected: {
      fromAgentId: request.expectedCurrentAgentId,
      toAgentId: params.targetAgentId,
    },
  });

  if (divider.status === 'absent') return committed.committed('divider_missing');
  // A row that EXISTS but carries a different transition payload is a known
  // state, not an indeterminate one: the view is committed and the reserved
  // localId is occupied by a stale or conflicting operation. It must never be
  // overwritten and never retried as a switch.
  if (divider.status === 'present' && !divider.matches) {
    return committed.committed('divider_conflict');
  }
  // The row could not be read or decoded at all: nothing can be established.
  // The row could not be read or decoded at all. That is a fact about the
  // BOUNDARY, not about the switch: the Session observably IS the target, so
  // reporting the codeless indeterminate arm here would deny a cutover we can
  // see and leave the client's armed switch alive in front of it.
  if (divider.status === 'unknown') return committed.committed('divider_unknown');

  const trustedLocalImagePaths = await resolveTrustedSessionAttachmentLocalImagePaths({
    cwd: params.workspacePath,
    metadata: request.input.meta,
  }).catch((): ReadonlySet<string> => new Set<string>());

  return await admitInputAndActivateTarget({
    credentials: params.credentials,
    request,
    localId,
    mode: params.mode,
    ctx: params.ctx,
    sanitizedMeta: sanitizeSessionUserMessageSendMeta(request.input.meta, {
      allowedLocalImagePaths: trustedLocalImagePaths,
      text: request.input.text,
    }),
    targetMetadata: params.committedMetadata,
    committed,
  });
}

export async function runSessionAgentTransition(params: Readonly<{
  credentials: Credentials;
  request: SessionAgentTransitionRequestV1;
  deps?: SessionAgentTransitionCoordinatorDeps;
}>): Promise<SessionAgentTransitionResultV1> {
  const now = params.deps?.now ?? Date.now;
  const { request } = params;
  const localId = readPendingLocalId(request.input.localId);
  // No usable correlation id, so the transition was never dispatched at all.
  if (!localId) return rejectUndispatchedSessionAgentTransition('unsupported_operation');

  // One effect ledger per invocation. The handle in scope is the proof of how
  // far the transition got, and it is the ONLY source of result arms. This tree
  // installs no admission fence by design, so it never advances through the
  // fenced stage.
  const effects = beginSessionAgentTransitionEffects({ localId });

  /* ---------------------------------------------------------------- 7.1 */

  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: request.sessionId,
  });
  if (!sessionTarget.ok || sessionTarget.sessionId !== request.sessionId) {
    return effects.rejected('forbidden');
  }

  const rawSession = sessionTarget.rawSession;
  if ((rawSession as { archivedAt?: unknown }).archivedAt != null) {
    return effects.rejected('unsupported_operation');
  }

  const metadata = asRecord(tryDecryptSessionMetadata({ credentials: params.credentials, rawSession }));
  if (!metadata) return effects.rejected('forbidden');

  const workspacePath = readNonEmptyString(metadata.path);
  if (!workspacePath) return effects.rejected('unsupported_operation');
  // One owner for "is there a canonical hosted transcript to continue from?",
  // shared with inspection so a Session can never pass one gate and fail the
  // other, and so neither disagrees with the canonical storage-kind owner.
  if (!hasCanonicalHostedTranscript(metadata)) return effects.rejected('unsupported_operation');

  const currentAgentId = resolveAgentIdFromSessionMetadata(metadata);
  if (!currentAgentId) return effects.rejected('unsupported_operation');

  // The target is resolved BEFORE the currentness comparison, because a Session
  // that already IS the target is not a stale client view — it is this
  // operation's own committed cutover seen again (section 7.5).
  const resolvedTarget = resolveSessionContinuationTargetAgent(request.selection);
  if (resolvedTarget.type === 'resolved' && currentAgentId === resolvedTarget.targetAgentId) {
    // Only a request that also EXPECTED the target is a genuine no-op.
    if (request.expectedCurrentAgentId === resolvedTarget.targetAgentId) {
      return effects.rejected('same_target');
    }
    return await reconcileAlreadyTargetedSession({
      credentials: params.credentials,
      request,
      localId,
      mode: sessionTarget.mode,
      ctx: sessionTarget.ctx,
      workspacePath,
      committedMetadata: metadata,
      targetAgentId: resolvedTarget.targetAgentId,
      effects,
    });
  }

  // A stale client view invalidates the request whatever the target turns out to
  // be, and it is the more actionable answer, so it is decided before target
  // resolution can shadow it with `target_unavailable`.
  if (currentAgentId !== request.expectedCurrentAgentId) return effects.rejected('stale_selection');
  if (resolvedTarget.type !== 'resolved') return effects.rejected('target_unavailable');
  const sourceAgentId = currentAgentId;
  const targetAgentId: AgentId = resolvedTarget.targetAgentId;

  // Sanitize the exact submitted input through the canonical owner before any
  // effect, so a rejected mention/attachment fails with the source untouched.
  //
  // This runs BEFORE the strict-idle proof, not between it and the stop. The
  // resolver stats, reads and hashes every referenced local image, so on a large
  // attachment set it is the longest step in the whole preflight — and this tree
  // installs no admission fence, which makes the idle observation the only thing
  // standing between a running source and the stop. Taking the proof after the
  // preparation keeps the observation and the act it authorizes adjacent; the
  // preparation consumes nothing the probe produces, so nothing is lost by
  // hoisting it.
  const trustedLocalImagePaths = await resolveTrustedSessionAttachmentLocalImagePaths({
    cwd: workspacePath,
    metadata: request.input.meta,
  }).catch((): ReadonlySet<string> => new Set<string>());
  const sanitizedMeta = sanitizeSessionUserMessageSendMeta(request.input.meta, {
    allowedLocalImagePaths: trustedLocalImagePaths,
    text: request.input.text,
  });

  const idleTimeoutMs = params.deps?.idleTimeoutMs ?? resolveSessionControlStopTimeoutMs();
  const idle = await waitForSessionIdle({
    credentials: params.credentials,
    idOrPrefix: request.sessionId,
    timeoutMs: idleTimeoutMs,
  });
  if (!idle.ok) return effects.rejected('source_not_idle');

  /* ---------------------------------------------------------------- 7.2 */

  // Recheck currentness immediately before the stop. There is no admission
  // fence here by design; this is the last pre-effect gate.
  const preStopSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: request.sessionId,
  }).catch((error: unknown) => {
    if (isAuthenticationError(error)) throw error;
    return null;
  });
  if (!preStopSession) return effects.rejected('forbidden');
  if (preStopSession.metadataVersion !== rawSession.metadataVersion) return effects.rejected('stale_selection');

  const stop = await requestSessionStop({
    credentials: params.credentials,
    idOrPrefix: request.sessionId,
  });
  // Resolution failed BEFORE any stop attempt (`session_not_found`,
  // `session_id_ambiguous`, `session_lookup_timeout`, `unsupported`), so the
  // source is provably still running — the one stop outcome whose
  // `sourceEffect: 'none'` promise is truthful, and the state this union's own
  // doc comment reserves `source_stop_failed` for. Reporting
  // `unsupported_operation` here told the user "Switching Agents isn't
  // supported for this Session" for what is a failed stop request.
  if (!stop.ok) return effects.rejected('source_stop_failed');
  // Section 7.2 step 6: only the fully confirmed stopped outcome permits
  // proceeding, and every unconfirmed one surfaces as `outcome_unknown` — the
  // source may already be gone, so `rejected`'s `sourceEffect: 'none'`, which
  // the UI turns into Keep editing, would be a claim the daemon cannot make.
  //
  // There is deliberately no allowlist of "pre-signal" reason strings here. The
  // reasons are a lossy channel and cannot carry the depth: `stopSession.ts`
  // emits `legacy_attachment`, `attachment_mismatch`, `missing_topology_proof`,
  // `terminal_host_adapter_unavailable` and `disposition_in_progress` both from
  // its pre-signal gates AND from the terminal-host disposition that runs after
  // SIGTERM with the runner exit already proven, and `target_daemon_unavailable`
  // both before addressing the owning machine and from the catch around the
  // STOP_SESSION RPC. Depth is what `stop.stopped` reports; the reason is
  // diagnostic only.
  if (!stop.stopped) return effects.outcomeUnknown();

  /* ---------------------------------------------------------------- 7.3 */

  // The stop is confirmed, so the effect stage advances: `rejected` no longer
  // exists on the handle in scope.
  const stopped = effects.stopConfirmed();

  const stoppedSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: request.sessionId,
  }).catch((error: unknown) => {
    if (isAuthenticationError(error)) throw error;
    return null;
  });
  // The stop is CONFIRMED and nothing has been written, so a failed read here is
  // a bounded source read failure at a KNOWN depth, not an indeterminate
  // outcome: the Session is still the source Agent and resume-source is safe.
  // Reporting `outcome_unknown` would withhold a recovery the daemon can prove.
  if (!stoppedSession) return stopped.sourceStopped('context_unavailable');
  if (stoppedSession.active === true) return stopped.sourceStopped('cutover_conflict');

  // The target view is projected from THIS row's plaintext, not from the
  // preflight metadata decrypted before the stop. The CAS versions committed
  // below come from this same read, so pairing them with older bytes would seal
  // a stale current view under a version number asserting it is current — a
  // metadata write accepted during the stop window would be silently reverted
  // with the CAS satisfied. Bytes and the version they are checked against are
  // one observation.
  const stoppedMetadata = asRecord(tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession: stoppedSession,
  }));
  // Same depth as the failed read above: bounded source read failure, nothing
  // written, source still the source Agent.
  if (!stoppedMetadata) return stopped.sourceStopped('context_unavailable');
  // Reading the current bytes is what makes the version meaningful, so the
  // current-Agent check has to move with it: adopting this row's version means
  // the CAS can no longer refuse a transition that committed its own cutover
  // during the stop window (section 7.3 — a concurrent second transition loses
  // the current-target or metadata-version check).
  if (resolveAgentIdFromSessionMetadata(stoppedMetadata) !== sourceAgentId) {
    return stopped.sourceStopped('cutover_conflict');
  }

  // Bounded context through the existing Replay owner. The transcript head is
  // read AFTER the confirmed stop, so a late source row remains canonical
  // history even when it missed this brief.
  const transcriptHeadSeq = typeof stoppedSession.seq === 'number' && Number.isFinite(stoppedSession.seq)
    ? Math.max(0, Math.floor(stoppedSession.seq))
    : 0;
  const seed = await resolveReplaySeedDraft({
    credentials: params.credentials,
    cwd: workspacePath,
    source: {
      // The Session is the same one; only the Agent running it changed. Asking
      // through `fork_chain` passed this Session as its own `previousSessionId`,
      // and the seed then told the target Agent it was continuing from a
      // previous Happy session — printing this Session's id as its predecessor.
      // Retrieval is identical; only the framing the seed can honestly make
      // differs.
      kind: 'same_session_agent_change',
      sessionId: request.sessionId,
      upToSeqInclusive: transcriptHeadSeq,
    },
    strategy: 'recent_messages',
    recentMessagesCount: configuration.replaySeedCandidateLimit,
    maxSeedChars: configuration.replaySeedMaxChars,
    candidateLimit: configuration.replaySeedCandidateLimit,
    // Section 8's other half. The cutover projection clears `sessionWorkStateV1` — the target
    // republishes its own — and the items are a structured projection rather than transcript
    // prose, so this is the last reader that can carry the in-flight plan across. Read through the
    // canonical display-safe reader: a malformed projection is no snapshot, not a raw object
    // forwarded into another Agent's prompt.
    workState: readDisplayableSessionWorkStateV1(stoppedMetadata.sessionWorkStateV1),
  }).catch((error: unknown): ReplaySeedDraftResolution => {
    if (isAuthenticationError(error)) throw error;
    return { status: 'unavailable' };
  });
  // Only a genuinely failed bounded retrieval may fail a transition whose
  // source is already stopped. An EMPTY source — a fresh Session where the user
  // switches Agent before sending anything — has nothing to carry over, which
  // is the trivially satisfiable case, and used to stop the source and then
  // fail the switch with `context_unavailable`.
  if (seed.status === 'unavailable') {
    return stopped.sourceStopped('context_unavailable');
  }

  const nowMs = now();
  const targetMetadata = projectCurrentAgentSessionView({
    metadata: stoppedMetadata,
    target: {
      agentId: targetAgentId,
      ...(request.selection.modelId ? { modelId: request.selection.modelId } : {}),
      ...(request.selection.acpSessionModeId ? { sessionModeId: request.selection.acpSessionModeId } : {}),
      ...(request.selection.sessionConfigOptionOverrides
        ? { sessionConfigOptionOverrides: request.selection.sessionConfigOptionOverrides }
        : {}),
      updatedAtMs: nowMs,
    },
  });
  // This projection is authoritative over the seed slot, not additive. An
  // unconsumed `replaySeedV1` left by an earlier operation is addressed to a
  // runtime that no longer exists, and leaving it in place lets the incoming
  // Agent's first turn be prefixed with an unrelated operation's replay context.
  // Either this operation's brief occupies the slot or nothing does.
  if (seed.status === 'seeded') {
    targetMetadata.replaySeedV1 = {
      v: 1,
      seedText: seed.seedDraft,
      sourceSessionId: request.sessionId,
      sourceCutoffSeqInclusive: seed.sourceCutoffSeqInclusive,
      createdAtMs: nowMs,
    };
  } else {
    delete targetMetadata.replaySeedV1;
  }

  const dividerLocalId = buildSessionAgentTransitionDividerLocalId(localId);
  const cutover = await commitSessionAgentTransitionCutover({
    token: params.credentials.token,
    sessionId: request.sessionId,
    currentView: {
      kind: 'legacy_v0',
      expectedMetadataVersion: stoppedSession.metadataVersion,
      metadataCiphertext: encryptStoredSessionPayload({
        mode: sessionTarget.mode,
        ctx: sessionTarget.ctx,
        payload: targetMetadata,
      }),
      expectedAgentStateVersion: stoppedSession.agentStateVersion,
      agentStateCiphertext: null,
    },
    divider: {
      localId: dividerLocalId,
      content: buildDividerContent({
        mode: sessionTarget.mode,
        ctx: sessionTarget.ctx,
        dividerLocalId,
        fromAgentId: sourceAgentId,
        toAgentId: targetAgentId,
      }),
    },
  });

  if (cutover.status === 'unknown') {
    logger.debug('[AGENT TRANSITION] Cutover outcome unknown', { reason: cutover.reason });
    return stopped.outcomeUnknown();
  }
  if (cutover.status === 'unsupported') {
    // The server predates the operation and wrote nothing, but the source is
    // already stopped, so this is not a no-effect rejection.
    return stopped.sourceStopped('cutover_conflict');
  }
  if (!cutover.response.ok && cutover.response.effect === 'none') {
    return stopped.sourceStopped('cutover_conflict');
  }
  if (!cutover.response.ok) {
    // A refused divider and an ABSENT divider are different recoveries and must
    // not be collapsed. `divider-conflict` means a row already exists at the
    // reserved localId carrying a different transition payload: retrying the
    // switch would re-derive the same conflict forever, and a later context
    // pass must not trust that row as this transition's boundary.
    return stopped.cutoverCommitted().committed(
      cutover.response.error === 'divider-conflict' ? 'divider_conflict' : 'divider_missing',
    );
  }

  /* ---------------------------------------------------------------- 7.4 */

  return await admitInputAndActivateTarget({
    credentials: params.credentials,
    request,
    localId,
    mode: sessionTarget.mode,
    ctx: sessionTarget.ctx,
    sanitizedMeta,
    targetMetadata,
    committed: stopped.cutoverCommitted(),
  });
}
