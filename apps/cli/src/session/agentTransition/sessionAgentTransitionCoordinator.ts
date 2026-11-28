import { isDeepStrictEqual } from 'node:util';

import { runFirstTransitionLaunch } from './failedFirstLaunch';
import {
  projectSessionMetadataForWire,
  buildBackendTargetKey,
  type BackendTargetRefV1,
  SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
  SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY,
  SessionAgentTransitionDividerV1Schema,
  beginSessionAgentTransitionEffects,
  buildSessionAgentTransitionDividerLocalId,
  isSessionStopConfirmed,
  matchesSessionAgentTransitionDividerAgentsV1,
  readPendingLocalId,
  readSessionAgentTransitionDividerFromStoredRecordV1,
  rejectUndispatchedSessionAgentTransition,
  sanitizeSessionUserMessageSendMeta,
  type ConnectedServiceBindingsV1,
  type SessionAgentTransitionCurrentViewCommitted,
  type SessionAgentTransitionRequestV1,
  type SessionAgentTransitionResultV1,
  type SessionAgentTransitionSourceUntouched,
  type SessionStoredMessageContent,
} from '@happier-dev/protocol';
import {
  AGENTS_CORE,
  projectCurrentAgentSessionView,
  resolveAgentIdFromSessionMetadata,
  type AgentId,
} from '@happier-dev/agents';

import { ApiClient } from '@/api/api';
import { buildConnectedServiceCredentialSpawnErrorResult } from '@/daemon/connectedServices/diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';
import {
  admitConnectedServiceAuthForSpawn,
  type ConnectedServiceSpawnAdmission,
} from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import { isConnectedServiceUxDiagnosticSpawnErrorDetail } from '@happier-dev/protocol';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { findTranscriptEncryptedMessageByLocalIdV2 } from '@/api/session/transcriptMessageLookup';
import {
  createConnectedServiceMaterializationIdentity,
} from '@/daemon/connectedServices/materialize/createConnectedServiceMaterializationIdentity';
import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
import type { Credentials } from '@/persistence';
import { resolveTrustedSessionAttachmentLocalImagePaths } from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';
import { admitSessionUserMessageToPendingQueue } from '@/session/services/admitSessionUserMessage';
import { resolveSessionMessagePermissionIntent } from '@/session/services/resolveSessionMessagePermissionIntent';
import { requestInactiveSessionResume } from '@/session/services/requestInactiveSessionResume';
import { requestSessionStop } from '@/session/services/requestSessionStop';
import { resolveSessionUserMessageRequestedAction } from '@/session/services/resolveSessionUserMessageRequestedAction';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import {
  resolveSessionAgentSpawnConnectedServicesDefaults,
} from '@/session/services/spawn/normalizeSessionAgentSpawnActionRequest';
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
import { resolveSessionPersistedRuntimeIdentity } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveConfiguredAcpBackendFromAccountSettings';
import { materializeConfiguredAcpEnvironment } from '@/agent/acp/catalog/configured/materializeConfiguredAcpEnvironment';

import {
  captureDepartingAgentNativeResumeRecord,
  createLocalAgentNativeResumeRecordStore,
  readAgentNativeReturnAccountSettings,
  resolveAgentNativeReturnPlan,
  type LocalAgentNativeResumeRecordStore,
} from './agentNativeReturn';
import { buildSessionAgentTransitionActivationBrief } from './buildSessionAgentTransitionActivationBrief';
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
 * A target that has run this Session on THIS machine before returns to the
 * native conversation it left: its vendor session id and the transcript head it
 * last saw are kept in a machine-local record written at its departure, the
 * current-view projector republishes that id as the target's single flat resume
 * key, and the Replay brief carries only the away-delta (`AM-24`, `AM-26`).
 * Every other target — including every target that never ran this Session — is
 * fresh: the source Agent's flat resume key is dropped by the projector and the
 * target starts from the FULL bounded Replay brief carried in
 * `metadata.replaySeedV1`, which the existing seed owner prefixes onto the first
 * provider-accepted prompt.
 *
 * There is no continuity proof and no pre-check of the recorded conversation: a
 * dead vendor id fails loudly at the first turn, exactly as any other Happier
 * resume does, and the user can switch back through the in-session picker.
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
  /**
   * Machine-local native-return records. Defaults to the daemon's own protected
   * local state; injected only where the disk boundary has to be stood in for.
   */
  localAgentNativeResumeRecordStore?: LocalAgentNativeResumeRecordStore;
  /** This Account's settings, for the shared vendor-resume eligibility gates. */
  readAccountSettings?: () => Record<string, unknown> | null;
  connectedServiceAdmission?: Pick<Parameters<typeof admitConnectedServiceAuthForSpawn>[0],
    'api' | 'credentialRefreshService' | 'accountUsageStore' | 'runtimeQuotaSnapshots'>;
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

/** One normalization for every transcript head this flow reads. */
function readTranscriptHeadSeq(rawSession: Readonly<{ seq?: unknown }>): number {
  return typeof rawSession.seq === 'number' && Number.isFinite(rawSession.seq)
    ? Math.max(0, Math.floor(rawSession.seq))
    : 0;
}

function buildDividerContent(params: Readonly<{
  mode: 'plain' | 'e2ee';
  ctx: Parameters<typeof encryptSessionPayload>[0]['ctx'];
  dividerLocalId: string;
  fromAgentId: string;
  toAgentId: string;
  fromBackendTarget?: BackendTargetRefV1;
  toBackendTarget?: BackendTargetRefV1;
  /**
   * The transcript cutoff the activation brief was built from, `0` when the
   * pass carried nothing over.
   *
   * Required at the schema too, not just here: nothing else records the pass's
   * upper bound once the cutover lands — `replaySeedV1.seedText` is blanked the
   * instant the target accepts it — so a writer that may omit it is a writer
   * that can silently make the boundary unexplainable. A sidecar without it
   * does not read as a divider at all.
   */
  sourceCutoffSeqInclusive: number;
  /**
   * The native-return departure bound this transition replayed FROM, or `null`
   * for a fresh target that had none.
   *
   * The cutoff above is the pass's upper bound; on a native return the pass also
   * had a lower one, and the delta between them is the whole handoff. That bound
   * lives only in this machine's departure record, which the next departure
   * overwrites, so recording it on the boundary it bounded is what keeps the
   * handoff reconstructable at all.
   *
   * `null` is written as an ABSENT key, not as a stored null: absence is already
   * the fresh target's meaning at the schema, and a second spelling for the same
   * fact is a state every reader would have to collapse.
   */
  returningAgentLastSeenSeqInclusive: number | null;
}>): SessionStoredMessageContent {
  // The sidecar goes through the contract owner's schema and key on the way OUT,
  // not only on the way in. The schema trims and bounds both ids, and the single
  // canonical reader strict-parses with it, so a writer that spelled the key or
  // skipped the parse could seal a row nothing downstream recognizes as a
  // divider: no separator, no attribution boundary, and a reserved localId
  // permanently occupied by a non-divider that no retry can replace.
  const sidecar = SessionAgentTransitionDividerV1Schema.parse({
    v: 1,
    fromAgentId: params.fromAgentId,
    toAgentId: params.toAgentId,
    ...(params.fromBackendTarget ? { fromBackendTarget: params.fromBackendTarget } : {}),
    ...(params.toBackendTarget ? { toBackendTarget: params.toBackendTarget } : {}),
    sourceCutoffSeqInclusive: params.sourceCutoffSeqInclusive,
    ...(params.returningAgentLastSeenSeqInclusive === null
      ? {}
      : { returningAgentLastSeenSeqInclusive: params.returningAgentLastSeenSeqInclusive }),
  });
  const payload = {
    role: 'agent',
    content: {
      type: 'event',
      id: params.dividerLocalId,
      data: {
        type: 'message',
        message: SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
        [SESSION_AGENT_TRANSITION_DIVIDER_SIDECAR_KEY]: sidecar,
      },
    },
  };
  if (params.mode === 'plain') {
    return { t: 'plain', v: payload };
  }
  return {
    t: 'encrypted',
    // The canonical sealer binds the encryption variant, stable localId, and
    // canonical full payload. An exact retry therefore re-derives byte-identical
    // content, while a changed payload cannot reuse the same ciphertext.
    c: encryptSessionPayload({ ctx: params.ctx, payload, idempotencyKey: params.dividerLocalId }),
  };
}

async function resolveTargetConnectedServiceBinding(params: Readonly<{
  credentials: Credentials;
  backendTarget: BackendTargetRefV1;
  explicitConnectedServices?: ConnectedServiceBindingsV1;
}>) {
  const resolved = params.explicitConnectedServices
    ? {
        connectedServices: params.explicitConnectedServices,
        connectedServicesUpdatedAt: Date.now(),
      }
    : await resolveSessionAgentSpawnConnectedServicesDefaults(params);

  if (!resolved || !Object.values(resolved.connectedServices.bindingsByServiceId)
    .some(binding => binding.source === 'connected')) return null;
  return {
    ...resolved,
    connectedServiceMaterializationIdentityV1: createConnectedServiceMaterializationIdentity(),
  };
}

/**
 * Bindings are Agent-scoped: a binding naming a service the target Agent's catalog does not
 * declare is exactly the failure the rebinding above exists to prevent. An explicit choice that
 * does that is refused before any effect instead of being dropped or reinterpreted.
 */
function isExplicitConnectedServicesChoiceSupported(
  targetAgentId: AgentId,
  connectedServices: ConnectedServiceBindingsV1,
): boolean {
  const supported: readonly string[] = AGENTS_CORE[targetAgentId].connectedServices?.supportedServiceIds ?? [];
  return Object.keys(connectedServices.bindingsByServiceId).every((serviceId) => supported.includes(serviceId));
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
  /** The committed target current view — the permission fallback and resume basis. */
  targetMetadata: Record<string, unknown>;
  firstLaunchAgentId?: AgentId;
  allowFirstLaunchCredentialRecovery?: boolean;
  admittedAuth?: Parameters<typeof runFirstTransitionLaunch>[2];
  /** Proof that the target current view is committed; the source of every arm here. */
  committed: SessionAgentTransitionCurrentViewCommitted;
}>): Promise<SessionAgentTransitionResultV1> {
  const { committed, localId, request } = params;

  // The frozen user input may carry a newer Session-global permission choice
  // that has not been published yet (`next_prompt`). The ordinary message
  // intent owner keeps it authoritative; older inputs still use the committed
  // post-stop metadata, rather than a stale preflight snapshot.
  const permission = resolveSessionMessagePermissionIntent({
    permissionModeOverride: typeof request.input.meta.permissionMode === 'string'
      ? request.input.meta.permissionMode
      : undefined,
    decryptedMetadata: params.targetMetadata,
  });
  if (!permission.ok) return committed.committed('input_rejected');
  const admission = await admitSessionUserMessageToPendingQueue({
    credentials: params.credentials,
    sessionId: request.sessionId,
    mode: params.mode,
    ctx: params.ctx,
    localId,
    text: request.input.text,
    meta: params.sanitizedMeta,
    permissionIntent: permission.permissionIntent,
    requestedAction: resolveSessionUserMessageRequestedAction({ deliveryIntent: 'runtime_bootstrap' }),
    ...(request.selection.modelId ? { modelId: request.selection.modelId } : {}),
  });
  if (admission.status === 'unconfirmed') {
    return committed.committed('input_admission_failed');
  }
  if (admission.status === 'suppressed') {
    return committed.committed('input_rejected');
  }
  if (admission.status === 'already_terminal') {
    // The exact localId is already in the terminal transcript, so this retry
    // has no pending work for a runtime to consume. Reactivating an inactive
    // target here would create unrelated work after custody has already ended.
    return committed.accepted();
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
    const launch = (transitionLaunchNonce?: string) => requestInactiveSessionResume({
      ...(transitionLaunchNonce ? { transitionLaunchNonce } : {}),
      credentials: params.credentials,
      sessionId: request.sessionId,
      localId,
      rawSession: committedSession,
      metadata: params.targetMetadata,
    });
    const committedMetadata = params.firstLaunchAgentId
      ? asRecord(tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: committedSession }))
      : null;
    const committedTarget = committedMetadata
      ? resolveSessionPersistedRuntimeIdentity(committedMetadata)?.backendTarget
      : null;
    // The original cutover's exact target and seed still own this metadata version.
    const resumed = params.firstLaunchAgentId && committedSession.active === false && committedMetadata
      && typeof committedSession.pendingVersion === 'number'
      && isDeepStrictEqual(committedMetadata.replaySeedV1, params.targetMetadata.replaySeedV1)
      && committedTarget?.kind === 'builtInAgent'
      && buildBackendTargetKey(committedTarget) === buildBackendTargetKey({ kind: 'builtInAgent', agentId: params.firstLaunchAgentId })
      ? await runFirstTransitionLaunch({
          sessionId: request.sessionId,
          agentId: params.firstLaunchAgentId,
          localId,
          metadataVersion: committedSession.metadataVersion,
          pendingVersion: committedSession.pendingVersion,
          allowCredentialRecovery: params.allowFirstLaunchCredentialRecovery,
        }, launch, params.admittedAuth)
      : await launch();
    if (!resumed.ok) {
      logger.debug('[AGENT TRANSITION] Target activation failed', { code: resumed.code, message: resumed.message });
      return committed.committed('target_start_failed');
    }
  }

  // `accepted` means the current view and divider committed and this localId
  // received canonical admission. It does NOT say the target came up: the resume
  // above passes no `waitForReady`, so it returns on an acknowledged spawn and a
  // runtime that dies seconds later still produced this arm. A real Session's
  // runtime died 94 seconds past this line while the client had been told
  // `accepted`, and said nothing. The client reads the runtime's absence from
  // canonical Session state instead (`resolveAwaitingRuntime` in
  // `continueSessionWithArmedAgent.ts`) rather than trusting this arm for it.
  return committed.accepted();
}

type DividerEvidence =
  | Readonly<{ status: 'present'; matches: boolean }>
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'unknown' }>;

async function readDividerEvidence(params: Readonly<{
  token: string;
  sessionId: string;
  dividerLocalId: string;
  mode: SessionStoredContentEncryptionMode;
  ctx: Parameters<typeof encryptSessionPayload>[0]['ctx'];
  expected: Readonly<{
    fromAgentId: string;
    toAgentId: string;
    fromBackendTarget?: BackendTargetRefV1;
    toBackendTarget?: BackendTargetRefV1;
  }>;
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
  const divider = readSessionAgentTransitionDividerFromStoredRecordV1({
    localId: params.dividerLocalId,
    record,
  });
  if (!divider) return { status: 'unknown' };
  return {
    status: 'present',
    matches: matchesSessionAgentTransitionDividerAgentsV1(divider, params.expected),
  };
}

function projectDividerEvidenceArm(
  evidence: DividerEvidence,
  committed: SessionAgentTransitionCurrentViewCommitted,
): SessionAgentTransitionResultV1 | null {
  if (evidence.status !== 'present' || !evidence.matches) {
    return committed.committed('divider_unavailable');
  }
  return null;
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
      ...(request.expectedCurrentBackendTarget?.kind === 'configuredAcpBackend'
        ? { fromBackendTarget: request.expectedCurrentBackendTarget } : {}),
      ...(request.selection.backendTarget?.kind === 'configuredAcpBackend'
        ? { toBackendTarget: request.selection.backendTarget } : {}),
    },
  });

  const dividerArm = projectDividerEvidenceArm(divider, committed);
  if (dividerArm) return dividerArm;

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
  const localAgentNativeResumeRecordStore =
    params.deps?.localAgentNativeResumeRecordStore ?? createLocalAgentNativeResumeRecordStore();
  const readAccountSettings = params.deps?.readAccountSettings ?? readAgentNativeReturnAccountSettings;
  const { request } = params;
  const localId = readPendingLocalId(request.input.localId);
  // No usable correlation id, so the transition was never dispatched at all.
  if (!localId) return rejectUndispatchedSessionAgentTransition('unsupported_operation');

  // Generic user-message metadata is an opaque wire record. Validate an
  // explicitly authored permission through the existing intent owner before
  // any source effect; absence preserves the incumbent metadata fallback.
  if (Object.prototype.hasOwnProperty.call(request.input.meta, 'permissionMode')) {
    const permissionModeOverride = request.input.meta.permissionMode;
    if (typeof permissionModeOverride !== 'string' || permissionModeOverride.trim().length === 0) {
      return rejectUndispatchedSessionAgentTransition('unsupported_operation');
    }
    try {
      resolveSessionMessagePermissionIntent({ permissionModeOverride, decryptedMetadata: null });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'invalid_arguments') {
        return rejectUndispatchedSessionAgentTransition('unsupported_operation');
      }
      throw error;
    }
  }

  // One effect ledger per invocation. The handle in scope is the proof of how
  // far the transition got, and it is the ONLY source of result arms. This tree
  // installs no admission fence by design, so it never advances through the
  // fenced stage.
  const effects = beginSessionAgentTransitionEffects({ localId });

  /* ---------------------------------------------------------------- 7.1 */

  const featureDecision = await resolveCliFeatureDecisionForServer({
    featureId: 'sessions.agentSwitching',
    env: process.env,
    serverUrl: resolveServerHttpBaseUrl(),
  }).catch(() => null);
  if (featureDecision?.decision.state !== 'enabled') {
    return effects.rejected('unsupported_operation');
  }

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
  // Deliberately NOT gated on the Session's recorded machine. Every failure such
  // a gate claimed to prevent is already detected by the component that actually
  // knows: `requestSessionStop` finds no local process for a Session that is not
  // here and reports it, the DEVICE-LOCAL native-return record is simply absent
  // and already degrades to a full replay, the cutover is server-side and
  // machine-agnostic, and activating the target on this host succeeds or fails
  // loudly. A machine-id comparison is only a PROXY for continuability, and it
  // was wrong in both directions — refusing a Session a user had legitimately
  // moved here while still admitting one whose vendor conversation was gone.

  const currentAgentId = resolveAgentIdFromSessionMetadata(metadata);
  if (!currentAgentId) return effects.rejected('unsupported_operation');
  const currentIdentity = resolveSessionPersistedRuntimeIdentity(metadata);
  if (!currentIdentity) return effects.rejected('unsupported_operation');
  if (currentIdentity.backendTarget.kind === 'configuredAcpBackend'
    && request.expectedCurrentAgentId === 'customAcp' && !request.expectedCurrentBackendTarget) {
    return effects.rejected('stale_selection');
  }
  const currentBackendTargetKey = buildBackendTargetKey(currentIdentity.backendTarget);
  const expectedBackendTarget = request.expectedCurrentBackendTarget
    ?? { kind: 'builtInAgent' as const, agentId: request.expectedCurrentAgentId };

  // Currentness is a committed metadata fact. A configured definition removed
  // after cutover cannot turn a retry into an untouched-source rejection.
  const accountSettings = readAccountSettings();
  const resolvedTarget = resolveSessionContinuationTargetAgent(request.selection, accountSettings);
  const requestedTarget = request.selection.backendTarget?.kind === 'configuredAcpBackend'
    ? request.selection.backendTarget
    : resolvedTarget.type === 'resolved' ? resolvedTarget.backendTarget : null;
  if (requestedTarget && currentBackendTargetKey === buildBackendTargetKey(requestedTarget)) {
    // Only a request that also EXPECTED the target is a genuine no-op.
    if (buildBackendTargetKey(expectedBackendTarget) === currentBackendTargetKey) {
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
      targetAgentId: currentAgentId,
      effects,
    });
  }

  // A stale client view invalidates the request whatever the target turns out to
  // be, and it is the more actionable answer, so it is decided before target
  // resolution can shadow it with `target_unavailable`.
  if (currentAgentId !== request.expectedCurrentAgentId || buildBackendTargetKey(expectedBackendTarget) !== currentBackendTargetKey) return effects.rejected('stale_selection');
  if (resolvedTarget.type !== 'resolved') return effects.rejected('target_unavailable');
  const sourceAgentId = currentAgentId;
  const targetAgentId: AgentId = resolvedTarget.targetAgentId;
  const targetBackendTarget = resolvedTarget.backendTarget;
  if (
    request.selection.connectedServices
    && !isExplicitConnectedServicesChoiceSupported(targetAgentId, request.selection.connectedServices)
  ) return effects.rejected('connected_account_unsupported');
  const targetBinding = await resolveTargetConnectedServiceBinding({
    credentials: params.credentials,
    backendTarget: targetBackendTarget,
    explicitConnectedServices: request.selection.connectedServices,
  }).catch((error: unknown) => {
    logger.debug('[AGENT TRANSITION] Target connected-service default unavailable', {
      agentId: targetAgentId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  let admittedAuth: ConnectedServiceSpawnAdmission | null = null;
  if (targetBinding && request.selection.connectedServices) {
    try {
      admittedAuth = await admitConnectedServiceAuthForSpawn({
        ...(params.deps?.connectedServiceAdmission ?? { api: await ApiClient.create(params.credentials) }),
        agentId: targetAgentId,
        credentials: params.credentials,
        connectedServicesBindingsRaw: targetBinding.connectedServices,
      });
    } catch (error) {
      const detail = buildConnectedServiceCredentialSpawnErrorResult({ agentId: targetAgentId, error })?.errorDetail;
      return effects.rejected('connected_account_unavailable',
        isConnectedServiceUxDiagnosticSpawnErrorDetail(detail) ? detail.uxDiagnostic : undefined);
    }
  }
  const returnPlan = targetBackendTarget.kind === 'configuredAcpBackend' ? null : await resolveAgentNativeReturnPlan({
    store: localAgentNativeResumeRecordStore,
    sessionId: request.sessionId,
    targetAgentId,
    sourceMetadata: metadata,
    accountSettings,
    ...(request.selection.connectedServices ? {
      selectedProfilesByServiceId: Object.fromEntries(
        Array.from(admittedAuth?.recordsByServiceId ?? [], ([serviceId, record]) => [serviceId, record.profileId]),
      ),
    } : {}),
  });
  const nativeReturn = returnPlan?.record;
  const materializationIdentity = (request.selection.connectedServices ? nativeReturn?.auth?.materializationIdentity : null)
    ?? targetBinding?.connectedServiceMaterializationIdentityV1;
  const configuredBackend = targetBackendTarget.kind === 'configuredAcpBackend' && accountSettings
    ? resolveConfiguredAcpBackendFromAccountSettings(accountSettings, targetBackendTarget.backendId) : null;
  if (configuredBackend && accountSettings) {
    try { materializeConfiguredAcpEnvironment({ backend: configuredBackend, accountSettings, credentials: params.credentials }); }
    catch { return effects.rejected('target_unavailable'); }
  }

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

  // 7.2 step 4. The departing Agent's native pair is both current and committed
  // at this instant — the version check above just proved the preflight bytes
  // are still the committed ones — so this is where a later return to it becomes
  // possible. It never gates the transition and never takes an exit.
  if (currentIdentity.backendTarget.kind === 'builtInAgent') await captureDepartingAgentNativeResumeRecord({
    store: localAgentNativeResumeRecordStore,
    sessionId: request.sessionId,
    sourceAgentId,
    sourceMetadata: metadata,
    // No Account settings: the capture records a STRUCTURALLY valid identity,
    // and whether this machine may resume it is decided on the way back
    // (`resolveAgentNativeReturnIdentity`). Deciding it here deleted the record
    // of an Agent the user had temporarily disabled.
    // The head as it stands HERE, before the stop — the boundary the departing
    // Agent's own conversation covers (`AM-26`). Deliberately not the post-stop
    // head the brief runs to: a row that lands between this instant and the
    // confirmed stop may never have reached the departing Agent, and
    // over-estimating the boundary skips it PERMANENTLY, while under-estimating
    // costs one re-replayed turn.
    departureSeqInclusive: readTranscriptHeadSeq(preStopSession),
  });

  const stop = await requestSessionStop({
    credentials: params.credentials,
    idOrPrefix: request.sessionId,
  }).catch(() => null);
  // A lost stop answer may have followed an accepted stop, so it remains
  // indeterminate. By contrast, the owner's `ok: false` arm is produced only
  // by identity resolution before it can address a runner. That pre-attempt
  // refusal proves the source remains untouched and still running.
  if (stop === null) return effects.outcomeUnknown();
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
  //
  // `stop.stopped` is not the only confirmed depth. `already_stopped` is the
  // stop owner's other CONFIRMED answer: it found no runtime to signal and read
  // the canonical Session row back inactive. Asking the owner's own predicate
  // keeps liveness a single fact this coordinator consumes rather than one it
  // re-derives from statuses.
  if (!isSessionStopConfirmed(stop)) return effects.outcomeUnknown();

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
  const stoppedIdentity = resolveSessionPersistedRuntimeIdentity(stoppedMetadata);
  if (!stoppedIdentity || buildBackendTargetKey(stoppedIdentity.backendTarget) !== currentBackendTargetKey) {
    return stopped.sourceStopped('cutover_conflict');
  }

  // 7.3 step 1: native eligibility FIRST, before any context decision. The
  // inversion is a stated risk spot — choosing a narrower context bound and only
  // then discovering that native return is unavailable omits history the fresh
  // target needs, and nothing in the result would say so.
  // Bounded context through the existing Replay owner. The transcript head is
  // read AFTER the confirmed stop, so a late source row remains canonical
  // history even when it missed this brief.
  const transcriptHeadSeq = readTranscriptHeadSeq(stoppedSession);
  const seed = await buildSessionAgentTransitionActivationBrief({
    credentials: params.credentials,
    sessionId: request.sessionId,
    sourceAgentId,
    targetAgentId,
    workspacePath,
    // The Session is stopped on the source Agent, so its current view IS the
    // departing Agent's — and only right here. The cutover projection below
    // clears the source Agent's own keys and the next Agent republishes into
    // them, so this is the last instant its tracked work and native log can be
    // read at all. The read-only rebuild that runs afterwards passes `null` and
    // omits them rather than reading whatever now sits in the same keys.
    departingAgentCurrentView: stoppedMetadata,
    transcriptHeadSeqInclusive: transcriptHeadSeq,
    // Only on a native return, and only from the resolved record: the target is
    // resuming the conversation it left, so the replay carries the delta since
    // that departure instead of restating history the target already holds
    // (`AM-26`). A target with no usable record hands `null` here and gets the
    // FULL replay — a fresh target can never be starved to an away-delta,
    // because there is no bound to starve it with.
    returningAgentLastSeenSeq: nativeReturn?.departureSeqInclusive ?? null,
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
  const dividerLocalId = buildSessionAgentTransitionDividerLocalId(localId);
  const divider = {
    localId: dividerLocalId,
    content: buildDividerContent({
      mode: sessionTarget.mode,
      ctx: sessionTarget.ctx,
      dividerLocalId,
      fromAgentId: sourceAgentId,
      toAgentId: targetAgentId,
      ...(currentIdentity.backendTarget.kind === 'configuredAcpBackend' ? { fromBackendTarget: currentIdentity.backendTarget } : {}),
      ...(targetBackendTarget.kind === 'configuredAcpBackend' ? { toBackendTarget: targetBackendTarget } : {}),
      // The exact post-stop upper bound U that this pass observed. A no-dialog
      // brief leaves the seed absent, but its divider still records U rather
      // than rewriting a non-empty transcript head as zero.
      sourceCutoffSeqInclusive: seed.status === 'seeded'
        ? seed.sourceCutoffSeqInclusive
        : transcriptHeadSeq,
      // The brief's OTHER bound, from the same resolved record that produced it.
      // A native return handed over only the away-delta, and the departure
      // record that bounded it is overwritten by the next departure — so unless
      // the boundary records it here, nothing can ever say what this Agent was
      // actually sent, and the read-only rebuild silently shows the full prefix
      // instead. `null` is the fresh target, which had no lower bound at all.
      returningAgentLastSeenSeqInclusive: nativeReturn?.departureSeqInclusive ?? null,
    }),
  };

  /**
   * Project, seal and commit against ONE observation of the source row.
   *
   * Bytes and the version they are checked against are one observation, so this
   * takes both together. That is also what makes a retry safe: it re-projects
   * from the refetched row rather than resending the stale target view under a
   * newer version, which would silently revert whatever moved the version.
   */
  const commitCutover = async (
    source: Readonly<{ metadataVersion: number; agentStateVersion: number }>,
    sourceCurrentView: Record<string, unknown>,
  ) => {
    const targetMetadata = projectCurrentAgentSessionView({
      metadata: sourceCurrentView,
      // The projector is the ONE writer of a flat vendor resume key, so a native
      // return travels through it rather than through a second writer beside it:
      // that is what keeps the one-identity invariant true by construction.
      // Absent, the target stays fresh — the predecessor behaviour.
      nativeResumeId: nativeReturn?.identity.vendorResumeId ?? null,
      target: {
        agentId: targetAgentId,
        backendTarget: targetBackendTarget,
        ...(configuredBackend ? { backendTitle: configuredBackend.title } : {}),
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
    if (targetBinding) {
      Object.assign(targetMetadata, targetBinding, { connectedServiceMaterializationIdentityV1: materializationIdentity });
    }
    const outcome = await commitSessionAgentTransitionCutover({
      token: params.credentials.token,
      sessionId: request.sessionId,
      currentView: {
        kind: 'legacy_v0',
        expectedMetadataVersion: source.metadataVersion,
        metadataCiphertext: encryptStoredSessionPayload({
          mode: sessionTarget.mode,
          ctx: sessionTarget.ctx,
          payload: projectSessionMetadataForWire(targetMetadata),
        }),
        expectedAgentStateVersion: source.agentStateVersion,
        agentStateCiphertext: null,
      },
      divider,
    });
    return { targetMetadata, outcome };
  };

  let attempt = await commitCutover(stoppedSession, stoppedMetadata);
  if (
    attempt.outcome.status === 'settled'
    && attempt.outcome.response.ok === false
    && attempt.outcome.response.effect === 'none'
    && attempt.outcome.response.error === 'version-mismatch'
  ) {
    // A CAS loss is not automatically a dead end. The version can move for a
    // write with nothing to do with the switch, and the source is ALREADY
    // stopped, so leaving the Session down when the transition is still
    // applicable is the worst outcome this flow can produce. Exactly one
    // refetch-and-rebuild: a second loss is a conflict, not a loop.
    const refreshed = await fetchSessionByIdCompat({
      token: params.credentials.token,
      sessionId: request.sessionId,
    }).catch((error: unknown) => {
      if (isAuthenticationError(error)) throw error;
      return null;
    });
    const refreshedMetadata = refreshed
      ? asRecord(tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: refreshed }))
      : null;
    const refreshedIdentity = refreshedMetadata ? resolveSessionPersistedRuntimeIdentity(refreshedMetadata) : null;
    if (
      !refreshed
      || !refreshedMetadata
      || !refreshedIdentity
      // The version moved BECAUSE a concurrent transition committed, or the
      // Session was archived. Re-sealing this operation's target view over
      // either would silently revert it.
      || buildBackendTargetKey(refreshedIdentity.backendTarget) !== currentBackendTargetKey
      || (refreshed as { archivedAt?: unknown }).archivedAt != null
    ) {
      return stopped.sourceStopped('cutover_conflict');
    }
    attempt = await commitCutover(refreshed, refreshedMetadata);
  }
  const { targetMetadata, outcome: cutover } = attempt;

  if (cutover.status === 'unknown') {
    logger.debug('[AGENT TRANSITION] Cutover outcome unknown', { reason: cutover.reason });
    return stopped.outcomeUnknown();
  }
  if (!cutover.response.ok && cutover.response.effect === 'none') {
    return stopped.sourceStopped('cutover_conflict');
  }
  if (!cutover.response.ok) {
    return stopped.cutoverCommitted().committed('divider_unavailable');
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
    ...(returnPlan?.noNativeReturnRecord || admittedAuth ? { firstLaunchAgentId: targetAgentId } : {}),
    allowFirstLaunchCredentialRecovery: returnPlan?.noNativeReturnRecord === true,
    ...(admittedAuth && materializationIdentity ? { admittedAuth: {
      materializationId: materializationIdentity.id,
      credentials: admittedAuth,
    } } : {}),
  });
}
