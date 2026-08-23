import {
  beginSessionAgentTransitionEffects,
  buildSessionAgentTransitionDividerLocalId,
  isSessionStopConfirmed,
  matchesSessionAgentTransitionDividerAgentsV1,
  readSessionAgentTransitionDividerFromStoredRecordV1,
  resolveLinkedExternalSessionAuthorityV1,
  type SessionAgentTransitionCurrentViewCommitted,
  type SessionAgentTransitionRejectedCodeV1,
  type SessionAgentTransitionRequestV1,
  type SessionAgentTransitionResultV1,
  type SessionAgentTransitionSelectionV1,
  type SessionAgentTransitionSourceUntouched,
  type AgentNativeResumeIdentityV1,
} from '@happier-dev/protocol';
import {
  resolveAgentIdFromSessionMetadata,
  projectCurrentAgentSessionView,
  type AgentId,
} from '@happier-dev/agents';
import {
  applyAcpConfigOptionIntentSessionMetadata,
  applyAcpSessionModeIntentSessionMetadata,
  applyModelIntentSessionMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';
import { type ProviderBoundModelRef } from '@happier-dev/protocol';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { buildProviderInputGenerationEpochId } from '@/agent/runtime/session/input/providerInputGenerationAdmission';
import { findTranscriptEncryptedMessageByLocalIdV2 } from '@/api/session/transcriptMessageLookup';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { callSessionProviderInputAdmission } from '@/daemon/startup/providerInputAdmissionRuntime';
import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
import {
  generateConnectedServiceMaterializationIdentityV1,
} from '@/daemon/connectedServices/materialization/identity';
import type { StoredCredentials } from '@/persistence';
import {
  resolveSessionSpawnConnectedServicesDefaultsPayload,
} from '@/session/services/spawnConnectedServicesDefaults';
import { buildHostSessionInputAdmissionV1 } from '@/session/services/sessionInputAdmissionIdentity';
import { requestInactiveSessionResume } from '@/session/services/requestInactiveSessionResume';
import { requestSessionStop } from '@/session/services/requestSessionStop';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { waitForSessionIdle } from '@/session/services/waitForSessionIdle';
import {
  decryptStoredSessionPayload,
  tryDecryptSessionOwnerMetadataView,
  type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { applySessionAgentTransitionCutover } from '@/session/transport/http/sessionsHttp';
import type { ReplaySeedV1 } from '@/agent/runtime/replaySeed/replaySeedV1';
import {
  resolveSessionControlStopTimeoutMs,
  resolveSessionMessageAdmissionTimeoutMs,
} from '@/session/transport/shared/sessionTimeouts';

import {
  buildBoundedActivationBrief,
  type BuildSessionAgentTransitionActivationBrief,
  type SessionAgentTransitionActivationBriefV1,
} from './buildSessionAgentTransitionActivationBrief';
import {
  captureDepartingAgentNativeResumeRecord,
  createLocalAgentNativeResumeRecordStore,
  readAgentNativeReturnAccountSettings,
  resolveAgentNativeReturnIdentity,
  type LocalAgentNativeResumeRecordStore,
} from './agentNativeReturn';
import {
  buildSessionAgentTransitionDividerPayload,
  sealSessionAgentTransitionCurrentView,
} from './sessionAgentTransitionCutoverPayload';
import { resolveSessionContinuationTargetAgent } from './sessionContinuationInspection';
import { resolveCurrentProviderSpawnDefinitiveRejection } from '@/providers/spawn/currentDefinitiveRejection';

/**
 * The invocation-local same-Session Agent transition (contract section 7).
 *
 * This is a composition, not a persisted state machine. It owns no slot, held
 * carrier, transition row, cursor, lease, timer, or phase enum: the submitted
 * `localId` is the whole correlation identity, and the daemon holds the input
 * snapshot only for this invocation.
 *
 * Every existing owner keeps its authority — transport/encryption resolution,
 * the Agent catalog, strict idle, the local provider-input admission seam,
 * confirmed stop, the server cutover command, ordinary inactive activation, and
 * canonical message admission. What this module adds is the ORDER and the one
 * public result mapping, whose central invariant is:
 *
 *   no code reachable after a confirmed stop is ever carried by `rejected`.
 *
 * That invariant is no longer this module's to remember. Result arms are built
 * only through the effect-stage handle threaded down the flow
 * (`beginSessionAgentTransitionEffects`, in the Protocol package beside the
 * result union): the handle in scope IS the proof of the depth reached, and a
 * `rejected` after the confirmed stop does not compile.
 */

/** Admission-seam identity for the transition's own generation fence. */
const SESSION_AGENT_TRANSITION_ADMISSION_SERVICE_ID = 'session.agentTransition';

export type SessionAgentTransitionDeps = Readonly<{
  resolveSessionTransportContext: typeof resolveSessionTransportContext;
  decryptOwnerMetadataView: typeof tryDecryptSessionOwnerMetadataView;
  readAgentCatalogSnapshot: typeof readAgentCatalogSnapshot;
  /**
   * The provider spawn owner's cold, definitive-rejection phase.  This is an
   * injected system-read boundary so inspection and mutation share one answer
   * without the coordinator acquiring, activating, or caching plugin state.
   */
  resolveCurrentProviderSpawnDefinitiveRejection:
    typeof resolveCurrentProviderSpawnDefinitiveRejection;
  waitForSessionIdle: typeof waitForSessionIdle;
  callSessionProviderInputAdmission: typeof callSessionProviderInputAdmission;
  requestSessionStop: typeof requestSessionStop;
  applySessionAgentTransitionCutover: typeof applySessionAgentTransitionCutover;
  requestInactiveSessionResume: typeof requestInactiveSessionResume;
  sendSessionMessage: typeof sendSessionMessage;
  findTranscriptMessageByLocalId: typeof findTranscriptEncryptedMessageByLocalIdV2;
  resolveServerHttpBaseUrl: typeof resolveServerHttpBaseUrl;
  /**
   * THE server-owned feature decision for this operation. It rides `deps` for
   * the same reason every other server call does: the coordinator is a daemon
   * component, and a decision it reaches for directly is a network call no
   * caller can substitute. The default is the one canonical resolver, so this
   * is an injection seam, not a second decision-maker.
   */
  resolveCliFeatureDecisionForServer: typeof resolveCliFeatureDecisionForServer;
  buildActivationBrief: BuildSessionAgentTransitionActivationBrief;
  /** Machine-local inactive-Agent native records (section 6.5). Dev-only depth. */
  localAgentNativeResumeRecordStore: LocalAgentNativeResumeRecordStore;
  /**
   * Account settings for the native-return decision: they carry each Agent's
   * selected launch mode and its account-level enablement, so the record this
   * transition writes and the one it consumes are judged against the launch mode
   * this machine will actually use.
   */
  readAccountSettings: () => Record<string, unknown> | null;
  /**
   * THE spawn-defaulting owner (`QA2-F02`). The projector clears the source
   * Agent's connected-service binding because it names a service only that
   * Agent's catalog declares; the target's own binding comes from the account's
   * stored per-Agent default through the SAME owner a new Session uses, so the
   * transition never becomes a second place a Session's binding is decided.
   */
  resolveSpawnConnectedServicesDefaults: typeof resolveSessionSpawnConnectedServicesDefaultsPayload;
  nowMs: () => number;
}>;

export type SessionAgentTransitionParams = Readonly<{
  credentials: StoredCredentials;
  request: SessionAgentTransitionRequestV1;
  /** Required for protected E2EE input admission; absent means plain-only. */
  machineAdmissionTransport?: Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport'];
  strictIdleTimeoutMs?: number;
  inputAdmissionTimeoutMs?: number;
  deps?: Partial<SessionAgentTransitionDeps>;
}>;

function resolveDeps(overrides: Partial<SessionAgentTransitionDeps> | undefined): SessionAgentTransitionDeps {
  return {
    resolveSessionTransportContext,
    decryptOwnerMetadataView: tryDecryptSessionOwnerMetadataView,
    readAgentCatalogSnapshot,
    resolveCurrentProviderSpawnDefinitiveRejection,
    waitForSessionIdle,
    callSessionProviderInputAdmission,
    requestSessionStop,
    applySessionAgentTransitionCutover,
    requestInactiveSessionResume,
    sendSessionMessage,
    findTranscriptMessageByLocalId: findTranscriptEncryptedMessageByLocalIdV2,
    resolveServerHttpBaseUrl,
    resolveCliFeatureDecisionForServer,
    buildActivationBrief: buildBoundedActivationBrief,
    localAgentNativeResumeRecordStore: createLocalAgentNativeResumeRecordStore(),
    readAccountSettings: readAgentNativeReturnAccountSettings,
    resolveSpawnConnectedServicesDefaults: resolveSessionSpawnConnectedServicesDefaultsPayload,
    nowMs: () => Date.now(),
    ...overrides,
  };
}

type TransportContext = Extract<
  Awaited<ReturnType<typeof resolveSessionTransportContext>>,
  { ok: true }
>;

function readCryptoContext(transport: TransportContext): SessionStoredContentCryptoContext {
  return transport.mode === 'plain'
    ? { mode: 'plain', ctx: null }
    : { mode: 'e2ee', ctx: transport.ctx };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readTranscriptHeadSeq(rawSession: Readonly<{ seq?: unknown }>): number {
  return typeof rawSession.seq === 'number' && Number.isFinite(rawSession.seq)
    ? Math.max(0, Math.trunc(rawSession.seq))
    : 0;
}

/**
 * Resolution failures BEFORE any stop attempt. Each keeps the source running,
 * so each may truthfully ride `rejected` with `sourceEffect: 'none'`.
 */
function mapTransportResolutionFailure(
  code: Extract<Awaited<ReturnType<typeof resolveSessionTransportContext>>, { ok: false }>['code'],
): SessionAgentTransitionRejectedCodeV1 {
  return code === 'encryption_material_unavailable' ? 'forbidden' : 'unsupported_operation';
}

/**
 * The projector owns identity and state disposition; the canonical intent
 * writers own the selected target intents. An omitted model/mode/override means
 * "target default", which is exactly the cleared state the projector produces —
 * so nothing is written for it and no second intent owner appears here.
 */
function buildTargetCurrentViewProjection(params: Readonly<{
  targetAgentId: AgentId;
  selection: SessionAgentTransitionSelectionV1;
  modelSelectionRef: ProviderBoundModelRef | null;
  nativeResumeIdentity: AgentNativeResumeIdentityV1 | null;
  activationSeed: ReplaySeedV1 | null;
  /**
   * The TARGET Agent's connected-service binding, already resolved from the
   * account default, or `null` for a target that runs on its native CLI auth.
   * Resolved once by the caller and passed as a value so this projector stays
   * pure and a cutover retry re-derives byte-identical bytes.
   */
  connectedServices: Readonly<{
    connectedServices: unknown;
    connectedServicesUpdatedAt: number;
    materializationIdentity: unknown;
  }> | null;
  updatedAtMs: number;
}>): (metadata: Record<string, unknown>) => Record<string, unknown> {
  return (metadata) => {
    let next = projectCurrentAgentSessionView(metadata, {
      // The target's OWN matched pair, recovered from this machine's record of
      // its previous departure (section 6.5), or `null` for a target that has
      // never run here or cannot prove its native session. Nothing is ever
      // carried across Agents: the projector clears every other Agent's key, and
      // the returning Agent republishes its own runtime descriptor either way.
      agentId: params.targetAgentId,
      nativeResumeIdentity: params.nativeResumeIdentity,
      runtimeDescriptor: null,
      agentScopedCurrentState: 'clear',
    }) as Record<string, unknown>;

    next = applyModelIntentSessionMetadata(next, {
      v: 1,
      // An omitted model means "the target's own default". The projector's
      // cleared state expresses that, but only by DELETING the key — and a
      // deleted key is indistinguishable from "never set" to every reader that
      // arbitrates a client-local pending selection against this intent's
      // timestamp. So the source Agent's model id stayed the newest surviving
      // opinion after the cutover: the composer chip kept naming it and the
      // target's resume was handed it, and the target then refused every
      // message. Writing the canonical CLEARED intent at the cutover timestamp
      // states the same fact where those readers can see it, through the same
      // single intent writer the chosen-model branch uses.
      selection: params.modelSelectionRef,
      updatedAt: params.updatedAtMs,
    }) as Record<string, unknown>;

    const acpSessionModeId = readNonEmptyString(params.selection.acpSessionModeId);
    if (acpSessionModeId) {
      next = applyAcpSessionModeIntentSessionMetadata(next, {
        v: 1,
        modeId: acpSessionModeId,
        updatedAt: params.updatedAtMs,
      }) as Record<string, unknown>;
    }

    for (const [configId, override] of Object.entries(
      params.selection.sessionConfigOptionOverrides?.overrides ?? {},
    )) {
      next = applyAcpConfigOptionIntentSessionMetadata(next, {
        v: 1,
        configId,
        value: override.value,
        updatedAt: params.updatedAtMs,
      }) as Record<string, unknown>;
    }

    // The projector cleared the SOURCE Agent's binding, its `updatedAt` and the
    // materialized credential home that carried it. A target with a configured
    // account default takes its own; a target without one continues on native
    // CLI auth, exactly as a Session created for that Agent would.
    if (params.connectedServices) {
      next = {
        ...next,
        connectedServices: params.connectedServices.connectedServices,
        connectedServicesUpdatedAt: params.connectedServices.connectedServicesUpdatedAt,
        // A materialized home is per-binding: reusing the source's id would
        // point the target at the departed Agent's home, and an existing-Session
        // spawn carrying connected bindings with NO identity is refused outright
        // (`missing_identity_and_resume_state`).
        connectedServiceMaterializationIdentityV1: params.connectedServices.materializationIdentity,
      };
    }

    // This projection is authoritative over the seed slot, not additive. An
    // unconsumed `replaySeedV1` left by an earlier operation is addressed to a
    // runtime that no longer exists, and leaving it in place lets the incoming
    // Agent's first turn be prefixed with an unrelated operation's replay
    // context. Either this operation's brief occupies the slot or nothing does.
    if (params.activationSeed) return { ...next, replaySeedV1: params.activationSeed };
    const withoutStaleSeed = { ...next };
    delete withoutStaleSeed.replaySeedV1;
    return withoutStaleSeed;
  };
}

/**
 * Resolves the TARGET Agent's connected-service binding for the cutover.
 *
 * Runs after the confirmed stop, so a failure must never fail the transition:
 * settings that cannot be read degrade to native rather than stranding a
 * Session whose source is already gone. The materialized-home identity is
 * minted here, once, alongside the binding it belongs to.
 */
async function resolveTargetConnectedServiceBinding(params: Readonly<{
  credentials: StoredCredentials;
  targetAgentId: AgentId;
  resolveSpawnConnectedServicesDefaults: SessionAgentTransitionDeps['resolveSpawnConnectedServicesDefaults'];
}>): Promise<Parameters<typeof buildTargetCurrentViewProjection>[0]['connectedServices']> {
  const resolved = await params.resolveSpawnConnectedServicesDefaults({
    agentId: params.targetAgentId,
    credentials: params.credentials,
  }).catch(() => null);
  if (!resolved) return null;
  return {
    connectedServices: resolved.connectedServices,
    connectedServicesUpdatedAt: resolved.connectedServicesUpdatedAt,
    materializationIdentity: generateConnectedServiceMaterializationIdentityV1(),
  };
}

type DividerEvidence =
  | Readonly<{ status: 'present'; matches: boolean }>
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'unknown' }>;

async function readDividerEvidence(params: Readonly<{
  deps: SessionAgentTransitionDeps;
  token: string;
  sessionId: string;
  dividerLocalId: string;
  crypto: SessionStoredContentCryptoContext;
  expected: Readonly<{
    fromAgentId: string;
    toAgentId: string;
  }>;
}>): Promise<DividerEvidence> {
  const outcome = await params.deps.findTranscriptMessageByLocalId({
    token: params.token,
    serverUrl: params.deps.resolveServerHttpBaseUrl(),
    sessionId: params.sessionId,
    localId: params.dividerLocalId,
  }).catch(() => ({ type: 'protocol_error' as const, error: null }));

  if (outcome.type === 'not_found') return { status: 'absent' };
  if (outcome.type !== 'found') return { status: 'unknown' };

  const content = outcome.message.content as Readonly<{ t?: unknown; c?: unknown; v?: unknown }>;
  let record: unknown;
  try {
    record = content.t === 'encrypted'
      ? decryptStoredSessionPayload({ ...params.crypto, value: String(content.c ?? '') })
      : content.v;
  } catch {
    return { status: 'unknown' };
  }
  // The row was fetched BY the reserved divider localId, so the canonical reader
  // gets the full divider identity — reserved outer localId plus sidecar —
  // rather than trusting the sidecar alone.
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

/**
 * The single divider-evidence projection, from a committed current view.
 *
 * The already-target reconciliation needs this projection. Returning `null`
 * means the divider is this operation's own and the caller may continue;
 * anything else is the terminal result.
 */
function projectDividerEvidenceArm(
  evidence: DividerEvidence,
  committed: SessionAgentTransitionCurrentViewCommitted,
): SessionAgentTransitionResultV1 | null {
  // The public contract deliberately does not reveal whether the unavailable
  // divider was absent, mismatched, or unreadable. All three leave a committed
  // target view whose boundary cannot be trusted, so none may admit input or
  // activate the target.
  if (evidence.status !== 'present' || !evidence.matches) {
    return committed.committed('divider_unavailable');
  }
  return null;
}

type ExactInputAdmission = Readonly<{
  result: SessionAgentTransitionResultV1;
  terminal: boolean;
}>;

async function admitExactInput(params: Readonly<{
  deps: SessionAgentTransitionDeps;
  credentials: StoredCredentials;
  sessionId: string;
  request: SessionAgentTransitionRequestV1;
  machineAdmissionTransport: SessionAgentTransitionParams['machineAdmissionTransport'];
  timeoutMs: number;
  /** Proof that the target current view is committed; the source of every arm here. */
  committed: SessionAgentTransitionCurrentViewCommitted;
}>): Promise<ExactInputAdmission> {
  const localId = params.request.input.localId;
  const send = await params.deps.sendSessionMessage({
    credentials: params.credentials,
    idOrPrefix: params.sessionId,
    message: params.request.input.text,
    localId,
    wait: false,
    // Custody only. The message owner activates an inactive Session itself
    // after a successful enqueue, so leaving this on would make it a SECOND
    // activation decision-maker beside the explicit step below: it spawns the
    // target, then the caller spawns it again because
    // `requestInactiveSessionResume` returns on the spawn acknowledgement,
    // before the row's `active` flag flips. It would also mislabel the public
    // result — an activation failure would come back as `ok: false` from the
    // ADMISSION call and map to `input_admission_failed`, telling the client to
    // re-admit a message that is already in durable custody instead of starting
    // the target. Opting out keeps one owner per concept and keeps
    // `input_admission_failed` meaning exactly that.
    resumeInactiveSession: false,
    timeoutMs: params.timeoutMs,
    ...(params.request.input.meta ? { messageMeta: params.request.input.meta } : {}),
    inputAdmission: buildHostSessionInputAdmissionV1('ui'),
    ...(params.machineAdmissionTransport
      ? { machineAdmissionTransport: params.machineAdmissionTransport }
      : {}),
  }).catch(() => null);

  if (send?.ok === true && send.localId === localId) {
    // The message owner alone knows whether this exact localId remains in
    // Pending. A terminal replay has already settled the input, but must not
    // wake an inactive target with no work to consume.
    return {
      result: params.committed.accepted(),
      terminal: send.terminal === true,
    };
  }
  if (send?.ok === false && send.admissionResult?.status === 'rejected') {
    return { result: params.committed.committed('input_rejected'), terminal: false };
  }
  // An unknown admission outcome still has a KNOWN depth: the current view is
  // committed. Section 7.5's safe action for both "input absent" and "input
  // unknown" is the same idempotent re-admission by localId, so reporting the
  // known depth is more truthful than the codeless arm. It is also what the
  // admission budget's expiry means — see `resolveSessionMessageAdmissionTimeoutMs`.
  return { result: params.committed.committed('input_admission_failed'), terminal: false };
}

/**
 * Section 7.4, from a committed target current view onward. Shared by the first
 * pass and by a retry that finds the cutover already committed, so activation
 * and admission have exactly one implementation.
 *
 * INPUT CUSTODY IS TAKEN BEFORE ACTIVATION, inverting section 7.4's written
 * order. `sendSessionMessage`'s invariant is enqueue-then-resume: starting a
 * runtime with no durable Pending row behind it creates unrecoverable work if
 * anything fails in that window.
 *
 * This does not reintroduce the held carrier that section 1.3 removed. That
 * carrier was cut because a durable row existing BEFORE cutover could be claimed
 * by the source. Here the source is already confirmed stopped and the Session
 * already IS the target, so a row created now can only ever be claimed by the
 * target; the ordinary materializer delivers it when the target comes up. The
 * daemon therefore holds the invocation-local snapshot only from RPC receipt to
 * this enqueue, a strictly shorter window than the plan's order implies.
 */
async function activateTargetAndAdmitInput(params: Readonly<{
  deps: SessionAgentTransitionDeps;
  credentials: StoredCredentials;
  request: SessionAgentTransitionRequestV1;
  machineAdmissionTransport: SessionAgentTransitionParams['machineAdmissionTransport'];
  admissionFence: Readonly<{ serviceId: string; groupId: string; epochId: string }>;
  inputAdmissionTimeoutMs: number;
  /** Proof that the target current view is committed; the source of every arm here. */
  committed: SessionAgentTransitionCurrentViewCommitted;
}>): Promise<SessionAgentTransitionResultV1> {
  const { committed, deps, credentials, request } = params;
  const localId = request.input.localId;
  const sessionId = request.sessionId;

  // Reopening is scoped to the transition's exact epoch. The fence lived in the
  // retired source runner, so `not_matched` against a fresh target consumer is
  // the expected no-op rather than a failure. It happens before admission so the
  // target's ordinary consumer is never started against a closed seam.
  await deps.callSessionProviderInputAdmission({
    credentials,
    sessionId,
    action: 'clear',
    serviceId: params.admissionFence.serviceId,
    groupId: params.admissionFence.groupId,
    epochId: params.admissionFence.epochId,
    applicationSettled: true,
  }).catch(() => undefined);

  const admitted = await admitExactInput({
    deps,
    credentials,
    sessionId,
    request,
    machineAdmissionTransport: params.machineAdmissionTransport,
    timeoutMs: params.inputAdmissionTimeoutMs,
    committed,
  });
  if (admitted.result.type !== 'accepted' || admitted.terminal) return admitted.result;

  const targetSession = await deps.resolveSessionTransportContext({
    credentials,
    idOrPrefix: sessionId,
  }).catch(() => null);
  if (!targetSession?.ok) return committed.committed('target_start_failed');

  const targetMetadata = deps.decryptOwnerMetadataView({
    credentials,
    rawSession: targetSession.rawSession,
    accountEncryptionMode: targetSession.accountEncryptionCurrentness.mode,
  });
  if (!targetMetadata) return committed.committed('target_start_failed');

  if (targetSession.rawSession.active !== true) {
    const resumed = await deps.requestInactiveSessionResume({
      credentials,
      sessionId,
      localId,
      rawSession: targetSession.rawSession,
      metadata: targetMetadata,
    }).catch(() => null);
    if (!resumed?.ok) return committed.committed('target_start_failed');
  }

  // `accepted` still means exactly what section 6.1 says: the current view and
  // divider committed and this localId received canonical admission. It does NOT
  // say the target came up. Activation here is an acknowledged spawn — no
  // readiness wait — so a target that dies seconds later still produced this
  // arm, and the client reads the runtime's absence from canonical Session state
  // rather than from this result (`resolveAwaitingRuntime` in
  // `continueSessionWithArmedAgent.ts`).
  return admitted.result;
}

/**
 * Section 7.5, rows 3 to 7: the Session already names the target Agent, so a
 * repeated invocation is a reconciliation, not a second switch. The divider and
 * the submitted localId are sufficient evidence; no marker or receipt exists.
 */
async function reconcileAlreadyTargetedSession(params: Readonly<{
  deps: SessionAgentTransitionDeps;
  credentials: StoredCredentials;
  request: SessionAgentTransitionRequestV1;
  transport: TransportContext;
  machineAdmissionTransport: SessionAgentTransitionParams['machineAdmissionTransport'];
  admissionFence: Readonly<{ serviceId: string; groupId: string; epochId: string }>;
  inputAdmissionTimeoutMs: number;
  effects: SessionAgentTransitionSourceUntouched;
}>): Promise<SessionAgentTransitionResultV1> {
  // The Session already NAMES the target, which is this operation's own cutover
  // seen again — so the depth advances on that observation before any arm is
  // built here. A rejection from this branch would promise an untouched source
  // in front of an already-committed Session.
  const committed = params.effects.cutoverObservedCommitted();
  const divider = await readDividerEvidence({
    deps: params.deps,
    token: params.credentials.token,
    sessionId: params.request.sessionId,
    dividerLocalId: buildSessionAgentTransitionDividerLocalId(params.request.input.localId),
    crypto: readCryptoContext(params.transport),
    expected: {
      fromAgentId: params.request.expectedCurrentAgentId,
      toAgentId: params.request.selection.agentId,
    },
  });

  const arm = projectDividerEvidenceArm(divider, committed);
  if (arm) return arm;

  return await activateTargetAndAdmitInput({
    deps: params.deps,
    credentials: params.credentials,
    request: params.request,
    machineAdmissionTransport: params.machineAdmissionTransport,
    admissionFence: params.admissionFence,
    inputAdmissionTimeoutMs: params.inputAdmissionTimeoutMs,
    committed,
  });
}

export async function runSessionAgentTransition(
  params: SessionAgentTransitionParams,
): Promise<SessionAgentTransitionResultV1> {
  const deps = resolveDeps(params.deps);
  const { credentials, request } = params;
  const localId = request.input.localId;
  const sessionId = request.sessionId;
  // Both windows are operator-tunable through the canonical session-timeout
  // owner. The idle wait is part of the stop sequence — it exists only to make
  // the stop safe — so it rides the session-control stop budget, matching the
  // predecessor tree; canonical message admission is a different boundary with
  // its own budget. A hard-coded window here ignored a raised
  // HAPPIER_SESSION_STOP_TIMEOUT_MS on exactly the slow machines it is set for.
  const inputAdmissionTimeoutMs = params.inputAdmissionTimeoutMs
    ?? resolveSessionMessageAdmissionTimeoutMs();

  // One effect ledger per invocation. The handle in scope is the proof of how
  // far the transition got, and it is the ONLY source of result arms.
  const effects = beginSessionAgentTransitionEffects({ localId });

  // The server-owned feature decision is the admission boundary for this
  // optional operation. Its resolver owns snapshot parsing, dependencies,
  // timeout, and fail-closed semantics; this coordinator only declines before
  // it can touch the source runtime.
  const featureDecision = await deps.resolveCliFeatureDecisionForServer({
    featureId: 'sessions.agentSwitching',
    env: process.env,
    serverUrl: deps.resolveServerHttpBaseUrl(),
  }).catch(() => null);
  if (featureDecision?.decision.state !== 'enabled') {
    return effects.rejected('unsupported_operation');
  }

  const admissionFence = {
    serviceId: SESSION_AGENT_TRANSITION_ADMISSION_SERVICE_ID,
    groupId: sessionId,
    epochId: buildProviderInputGenerationEpochId({
      runtimeIdentityKey: `${SESSION_AGENT_TRANSITION_ADMISSION_SERVICE_ID}:${localId}`,
      targetRevision: 1,
      serviceId: SESSION_AGENT_TRANSITION_ADMISSION_SERVICE_ID,
      groupId: sessionId,
    }),
  } as const;

  /* --------------------------------------------------------------------- *
   * 7.1 Preflight. Nothing below this block may touch the source runtime.
   * --------------------------------------------------------------------- */

  const transport = await deps.resolveSessionTransportContext({ credentials, idOrPrefix: sessionId })
    .catch(() => null);
  if (!transport) return effects.rejected('unsupported_operation');
  if (!transport.ok) return effects.rejected(mapTransportResolutionFailure(transport.code));
  if (transport.sessionId !== sessionId) return effects.rejected('unsupported_operation');

  const archivedAt = (transport.rawSession as { archivedAt?: unknown }).archivedAt;
  if (archivedAt !== null && archivedAt !== undefined) return effects.rejected('unsupported_operation');

  const sourceMetadata = deps.decryptOwnerMetadataView({
    credentials,
    rawSession: transport.rawSession,
    accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
  });
  if (!sourceMetadata) return effects.rejected('forbidden');

  // Direct/external transcript Sessions are excluded: the target cannot consume
  // their storage canonically (section 2.3). Read through the discriminated
  // authority owner, and require `persisted` POSITIVELY: this is the last gate
  // before the source runtime is quiesced and stopped, and a link that exists
  // but cannot be trusted must not read as "hosted here".
  const sourceTranscriptAuthority = resolveLinkedExternalSessionAuthorityV1(sourceMetadata);
  if (
    !sourceTranscriptAuthority.ok
    || sourceTranscriptAuthority.transcriptStorage !== 'persisted'
  ) {
    return effects.rejected('unsupported_operation');
  }

  // Deliberately NOT gated on the Session's recorded machine. Every failure such
  // a gate claimed to prevent is already detected by the component that actually
  // knows: the stop owner finds no local process for a Session that is not here
  // and reports it, the DEVICE-LOCAL native-return record is simply absent and
  // already degrades to a full replay, the cutover is server-side and
  // machine-agnostic, and activating the target on this host succeeds or fails
  // loudly. A machine-id comparison is only a PROXY for continuability, and it
  // was wrong in both directions — refusing a Session a user had legitimately
  // moved here while still admitting one whose vendor conversation was gone.

  // One owner, shared with the inspection, so a target can never be reported
  // switchable there and then refused here — least of all at activation, after
  // the source is already stopped. It answers Sessions capability as well as
  // catalog identity and representability.
  const target = resolveSessionContinuationTargetAgent({
    readAgentCatalogSnapshot: deps.readAgentCatalogSnapshot,
    agentId: request.selection.agentId,
  });
  const currentAgentId = resolveAgentIdFromSessionMetadata(sourceMetadata);

  // Whether the Session already IS the requested target is a fact about the
  // committed current view, so it is decided against the REQUESTED selection,
  // not against what this daemon can currently launch. Gating it on catalog
  // resolution would send a retry whose target Agent has since been unloaded
  // back through `stale_selection` — promising an untouched source although the
  // cutover already committed. The reconcile below never needs the resolved
  // target: it matches the divider against the requested selection.
  if (currentAgentId !== null && currentAgentId === request.selection.agentId) {
    // Already the target. Only a request that also EXPECTED the target is a
    // genuine no-op; otherwise this repeats an operation whose cutover already
    // committed, and section 7.5 owns the answer.
    if (request.expectedCurrentAgentId === currentAgentId) return effects.rejected('same_target');
    return await reconcileAlreadyTargetedSession({
      deps,
      credentials,
      request,
      transport,
      machineAdmissionTransport: params.machineAdmissionTransport,
      admissionFence,
      inputAdmissionTimeoutMs,
      effects,
    });
  }

  // A stale client view invalidates the request whatever the target turns out to
  // be, and it is the more actionable answer, so it is decided before catalog
  // resolution can shadow it with `target_unavailable`.
  if (currentAgentId === null || currentAgentId !== request.expectedCurrentAgentId) {
    return effects.rejected('stale_selection');
  }
  if (!target) return effects.rejected('target_unavailable');
  const providerPreflight = await deps.resolveCurrentProviderSpawnDefinitiveRejection({
    agentTargetKey: target.backendTargetKey,
    agentId: target.agentId,
    selection: request.selection,
  });
  if (!providerPreflight.ok) return effects.rejected('target_unavailable');
  const modelSelectionRef = providerPreflight.ref;
  const sourceAgentId = currentAgentId;

  const idle = await deps.waitForSessionIdle({
    credentials,
    idOrPrefix: sessionId,
    timeoutMs: params.strictIdleTimeoutMs ?? resolveSessionControlStopTimeoutMs(),
  }).catch(() => null);
  if (!idle?.ok) return effects.rejected('source_not_idle');

  /* --------------------------------------------------------------------- *
   * 7.2 Quiesce and stop.
   * --------------------------------------------------------------------- */

  // The depth advances BEFORE the fence is requested, not after its answer is
  // inspected. A request that throws or times out proves only that no ANSWER
  // arrived — the session RPC may have delivered and applied it — so from here
  // on every pre-stop exit reopens this exact epoch, and the stage owns that
  // reopen so no exit site can forget it.
  const fenced = effects.withInputFence(async () => {
    await deps.callSessionProviderInputAdmission({
      credentials,
      sessionId,
      action: 'clear',
      serviceId: admissionFence.serviceId,
      groupId: admissionFence.groupId,
      epochId: admissionFence.epochId,
    }).catch(() => undefined);
  });

  const enforced = await deps.callSessionProviderInputAdmission({
    credentials,
    sessionId,
    action: 'enforce',
    reason: 'generation_pending',
    serviceId: admissionFence.serviceId,
    groupId: admissionFence.groupId,
    epochId: admissionFence.epochId,
  }).catch(() => null);
  // `enforce` returns only once in-flight provider dispatches and pending
  // materialization turns have quiesced. Anything else is a missing ANSWER, not
  // proof of a missing fence: the call reaches the session runtime over a
  // session RPC, and `requestSessionProviderInputAdmission` throws for every
  // non-`enforced` outcome — including a transport failure raised after the
  // request was delivered and applied. Returning `rejected` on that evidence
  // would promise `sourceEffect: 'none'`, which the UI turns into Keep editing,
  // while the source may be silently refusing local provider input. So this
  // exit reopens the exact epoch first, exactly like every other post-fence
  // pre-stop exit; `not_matched` against a source that was never fenced is the
  // expected no-op.
  if (enforced?.status !== 'enforced') {
    return await fenced.rejected('source_not_idle');
  }

  // Recheck currentness immediately before stop: the drain above may have taken
  // arbitrary time, and a concurrent transition or metadata write invalidates
  // the expected source.
  const preStop = await deps.resolveSessionTransportContext({ credentials, idOrPrefix: sessionId })
    .catch(() => null);
  if (!preStop?.ok) {
    return await fenced.rejected('stale_selection');
  }
  const preStopMetadata = deps.decryptOwnerMetadataView({
    credentials,
    rawSession: preStop.rawSession,
    accountEncryptionMode: preStop.accountEncryptionCurrentness.mode,
  });
  if (
    !preStopMetadata
    || resolveAgentIdFromSessionMetadata(preStopMetadata) !== sourceAgentId
    || ((preStop.rawSession as { archivedAt?: unknown }).archivedAt ?? null) !== null
  ) {
    return await fenced.rejected('stale_selection');
  }

  // 7.2 step 4. The departing Agent's matched native pair is only both current
  // and committed at this instant, so this is where a later return to it becomes
  // possible. It never gates the transition and never takes an exit, so the
  // fence contract above is untouched: the record decides only whether a FUTURE
  // return is native.
  if (sourceAgentId) {
    await captureDepartingAgentNativeResumeRecord({
      store: deps.localAgentNativeResumeRecordStore,
      sessionId,
      sourceAgentId,
      sourceMetadata: preStopMetadata,
      // No Account settings: the capture records a STRUCTURALLY valid identity,
      // and whether this machine may resume it is decided on the way back
      // (`resolveAgentNativeReturnIdentity`). Deciding it here deleted the
      // record of an Agent the user had temporarily disabled.
      // The head as it stands HERE, before the stop — the boundary the departing
      // Agent's own conversation covers (`AM-26`). Deliberately not the
      // post-stop head the divider records: a row that lands between this
      // instant and the confirmed stop may never have reached the departing
      // Agent, and over-estimating the boundary skips it PERMANENTLY, while
      // under-estimating costs one re-replayed turn.
      departureSeqInclusive: readTranscriptHeadSeq(preStop.rawSession),
    });
  }

  const stop = await deps.requestSessionStop({ credentials, idOrPrefix: sessionId })
    .catch(() => null);
  if (stop === null) {
    // The stop call itself failed in a way that proves nothing. The source may
    // already be gone, so `sourceEffect: 'none'` would be a lie.
    return await fenced.outcomeUnknown();
  }
  if (stop.ok === false) {
    // The stop owner's `ok: false` arm is returned only by its identity
    // resolver, before it can address a runner. That leaves the source both
    // untouched and still running, so this is the one pre-attempt stop refusal
    // that truthfully rides the rejected arm. `fenced.rejected` reopens this
    // exact epoch before it returns that fact.
    return await fenced.rejected('source_stop_failed');
  }
  if (!isSessionStopConfirmed(stop)) {
    // physical_stop_unconfirmed / stopped_projection_unconfirmed /
    // stopped_cleanup_incomplete all leave the source possibly gone.
    //
    // `already_stopped` does not, and is why this asks the stop owner's own
    // predicate instead of reading `stop.stopped`: the owner found no runtime to
    // signal and read the canonical Session row back inactive, which is a
    // confirmed stop. Liveness stays one fact owned by one component.
    return await fenced.outcomeUnknown();
  }

  /* --------------------------------------------------------------------- *
   * 7.3 Context and cutover. The stop is confirmed, so the effect stage
   * advances: `rejected` no longer exists on the handle in scope.
   * --------------------------------------------------------------------- */

  const stopped = fenced.stopConfirmed();

  const stoppedSession = await deps.resolveSessionTransportContext({ credentials, idOrPrefix: sessionId })
    .catch(() => null);
  // Section 6.1 partitions this depth by CAUSE, not by convenience: a bounded
  // source read/decryption failure is `context_unavailable`; `cutover_conflict`
  // is reserved for current-view active/archive/version loss, which this read
  // never observed. Both ride `source_stopped`, so the arm guarantee is
  // unaffected — only the reported reason was wrong.
  if (!stoppedSession?.ok) return stopped.sourceStopped('context_unavailable');

  const stoppedMetadata = deps.decryptOwnerMetadataView({
    credentials,
    rawSession: stoppedSession.rawSession,
    accountEncryptionMode: stoppedSession.accountEncryptionCurrentness.mode,
  });
  if (!stoppedMetadata) return stopped.sourceStopped('context_unavailable');
  if (resolveAgentIdFromSessionMetadata(stoppedMetadata) !== sourceAgentId) {
    return stopped.sourceStopped('cutover_conflict');
  }
  if (((stoppedSession.rawSession as { archivedAt?: unknown }).archivedAt ?? null) !== null) {
    return stopped.sourceStopped('cutover_conflict');
  }

  // 7.3 step 1: native eligibility FIRST, before any context decision. Section
  // 10.1 risk spot 3 is exactly the inversion — choosing a narrower context
  // bound and only then discovering that native return is unavailable omits
  // history the fresh target needs, and nothing in the result would say so.
  const nativeReturn = await resolveAgentNativeReturnIdentity({
    store: deps.localAgentNativeResumeRecordStore,
    sessionId,
    targetAgentId: target.agentId,
    sourceMetadata: stoppedMetadata,
    accountSettings: deps.readAccountSettings(),
  });

  // Capture U once from the post-stop row. A no-dialog result means no prompt
  // text crossed the boundary; it does not erase the canonical transcript head
  // the bounded pass observed.
  const transcriptHeadSeq = readTranscriptHeadSeq(stoppedSession.rawSession);

  const brief = await Promise.resolve(deps.buildActivationBrief({
    credentials,
    sessionId,
    // Head U is captured AFTER the confirmed stop. Later rows remain canonical
    // history even when they were too late for the already-built brief.
    transcriptHeadSeqInclusive: transcriptHeadSeq,
    sourceMetadata: stoppedMetadata,
    // The same bytes in both roles here, and only here: the Session is stopped
    // on the source Agent, so its current view IS the departing Agent's. That
    // stops being true one statement later — the cutover projection below clears
    // the source Agent's own keys, and the next Agent republishes into them — so
    // this is the last instant its tracked work and native log can be read at
    // all. The read-only rebuild that runs afterwards passes `null` and omits
    // them rather than reading whatever now sits in the same keys.
    departingAgentCurrentView: stoppedMetadata,
    // Only on a native return, and only from the resolved record: the target is
    // resuming the conversation it left, so the replay carries the delta since
    // that departure instead of restating history the target already holds
    // (`AM-26`). A target with no usable record hands `null` here and gets the
    // FULL replay — a fresh target can never be starved to an away-delta,
    // because there is no bound to starve it with.
    returningAgentLastSeenSeq: nativeReturn?.departureSeqInclusive ?? null,
    // Section 9's retrieval pointer needs both ends of the switch: the target
    // decides which tool channel the seed may name, and the source names the
    // native log the seed may point at.
    targetAgentId: target.agentId,
    sourceAgentId,
  })).catch((): SessionAgentTransitionActivationBriefV1 => ({ status: 'unavailable' }));
  if (brief.status !== 'available') return stopped.sourceStopped('context_unavailable');

  const targetConnectedServices = await resolveTargetConnectedServiceBinding({
    credentials,
    targetAgentId: target.agentId,
    resolveSpawnConnectedServicesDefaults: deps.resolveSpawnConnectedServicesDefaults,
  });

  const projectTargetView = buildTargetCurrentViewProjection({
    targetAgentId: target.agentId,
    selection: request.selection,
    modelSelectionRef,
    nativeResumeIdentity: nativeReturn?.identity ?? null,
    activationSeed: brief.seed,
    connectedServices: targetConnectedServices,
    updatedAtMs: deps.nowMs(),
  });

  const divider = buildSessionAgentTransitionDividerPayload({
    ...readCryptoContext(stoppedSession),
    submittedLocalId: localId,
    fromAgentId: sourceAgentId,
    toAgentId: target.agentId,
    // The exact post-stop upper bound U that this pass observed. A no-dialog
    // brief leaves the seed absent, but its divider still records U rather than
    // rewriting a non-empty transcript head as zero.
    sourceCutoffSeqInclusive: brief.seed?.sourceCutoffSeqInclusive ?? transcriptHeadSeq,
    // The brief's OTHER bound, from the same resolved record that produced it.
    // A native return handed over only the away-delta, and the departure record
    // that bounded it is overwritten by the next departure — so unless the
    // boundary records it here, nothing can ever say what this Agent was
    // actually sent, and the read-only rebuild silently shows the full prefix
    // instead. `null` is the fresh target, which had no lower bound at all.
    returningAgentLastSeenSeqInclusive: nativeReturn?.departureSeqInclusive ?? null,
  });

  const commitCutover = async (
    source: TransportContext,
  ): Promise<Awaited<ReturnType<typeof applySessionAgentTransitionCutover>>> => {
    const sealed = await sealSessionAgentTransitionCurrentView({
      ...readCryptoContext(source),
      credentials,
      accountEncryptionCurrentness: source.accountEncryptionCurrentness,
      rawSession: source.rawSession,
      projectTargetView,
    });
    if (!sealed.ok) {
      // Sealing decrypts the source tuple; a failure here is a bounded source
      // read failure, not a currentness conflict.
      return { ok: false, effect: 'none', error: 'internal' };
    }
    return await deps.applySessionAgentTransitionCutover({
      token: credentials.token,
      sessionId,
      currentView: sealed.currentView,
      divider,
    });
  };

  let cutover = await commitCutover(stoppedSession);
  if (cutover.ok === false && cutover.effect === 'none' && cutover.error === 'version-mismatch') {
    // Exactly one refetch-and-rebuild. A second loss is a conflict, not a loop.
    const refreshed = await deps.resolveSessionTransportContext({ credentials, idOrPrefix: sessionId })
      .catch(() => null);
    const refreshedMetadata = refreshed?.ok
      ? deps.decryptOwnerMetadataView({
          credentials,
          rawSession: refreshed.rawSession,
          accountEncryptionMode: refreshed.accountEncryptionCurrentness.mode,
        })
      : null;
    if (
      !refreshed?.ok
      || !refreshedMetadata
      || resolveAgentIdFromSessionMetadata(refreshedMetadata) !== sourceAgentId
      || ((refreshed.rawSession as { archivedAt?: unknown }).archivedAt ?? null) !== null
    ) {
      return stopped.sourceStopped('cutover_conflict');
    }
    cutover = await commitCutover(refreshed);
  }

  if (cutover.ok === false) {
    if (cutover.effect === 'none') {
      return cutover.error === 'internal'
        ? stopped.sourceStopped('context_unavailable')
        : stopped.sourceStopped('cutover_conflict');
    }
    if (cutover.effect === 'current_view_committed') {
      return stopped.cutoverCommitted().committed('divider_unavailable');
    }
    return stopped.outcomeUnknown();
  }

  /* --------------------------------------------------------------------- *
   * 7.4 Target activation and exact input admission.
   * --------------------------------------------------------------------- */

  return await activateTargetAndAdmitInput({
    deps,
    credentials,
    request,
    machineAdmissionTransport: params.machineAdmissionTransport,
    admissionFence,
    inputAdmissionTimeoutMs,
    committed: stopped.cutoverCommitted(),
  });
}
