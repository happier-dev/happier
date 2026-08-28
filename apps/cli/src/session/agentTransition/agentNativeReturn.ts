import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

import {
  evaluateVendorResumeEligibility,
  projectCurrentAgentSessionView,
  readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata,
  resolveAgentNativeResumeIdentityFromSessionMetadata,
  resolveAgentNativeTranscriptPathFromSessionMetadata,
  type AgentId,
} from '@happier-dev/agents';
import type { AgentNativeResumeIdentityV1 } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import {
  isReplaySeedV1PendingProviderAcceptance,
  readReplaySeedV1FromMetadata,
} from '@/agent/runtime/replaySeed/replaySeedV1';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { resolveAgentNativeSessionLogPathForAgent } from '@/session/handoff/metadata/catalogHooks';
import {
  createLocalSessionHandoffMetadataStore,
  type LocalAgentNativeResumeRecordKey,
  type LocalAgentNativeResumeRecordV1,
} from '@/session/handoff/metadata/localSessionHandoffMetadataStore';

/**
 * Same-machine native return (contract sections 6.5, 7.2 step 4, 7.3 step 1).
 *
 * Switching Agent A away and later back is the case this exists for. Without it
 * the returning Agent always starts a brand-new native conversation seeded only
 * by the bounded brief; with it, the Agent resumes the exact native session it
 * left, and the brief carries only what happened while it was gone.
 *
 * The record is machine-local because a vendor session belongs to the machine
 * that ran it — an id recorded here cannot be resumed anywhere else.
 *
 * Three rules make this safe, and each is delegated rather than re-decided here:
 *
 * 1. **One eligibility owner, consulted at the RETURN.** Whether a recorded id
 *    may be resumed at all is decided by `evaluateVendorResumeEligibility` —
 *    the same owner the ordinary inactive-resume path consults — against the
 *    exact projected target view the cutover is about to commit, and against
 *    this Account's settings. Those settings carry the Agent's selected launch
 *    mode and its account-level enablement, and both are transient and
 *    reversible: they say what this machine will do NOW, never what the
 *    departing conversation was. So the DEPARTURE records a structurally valid
 *    identity regardless of them, and this decision is taken on the way back.
 *    Evaluating it at capture wrote `identity: null` for an Agent the user had
 *    temporarily switched off, deleting the only copy of that continuity, and
 *    re-enabling the Agent afterwards could not recover it.
 * 2. **The accepted-context boundary owns the advance.** The recorded seq moves
 *    forward only once the provider accepted the context this activation handed
 *    the Agent (`REQ-STATE-03`). A failed strict native identity is invalidated
 *    by the strict-resume owner before any later departure capture can observe
 *    it; replay-seed retirement is context acceptance, not native identity
 *    acceptance.
 * 3. **No pre-check of the conversation itself.** There is deliberately no
 *    proof, no `stat()`, and no liveness probe on the recorded id (`AM-24`). A
 *    dead id fails LOUDLY at the first turn — Claude raises
 *    `ClaudeAgentSdkResumeIdentityMismatchError`, Codex's `thread/resume` throws
 *    with no fresh-start fallback — which is the same contract every other
 *    Happier resume already has, and the user can switch back through the
 *    in-session Agent picker.
 *
 * Anything refused degrades to a fresh target plus the FULL bounded context,
 * never to an arbitrary native session and never to a starved replay.
 */

/**
 * The record surface this module needs. Narrower than the whole handoff store so
 * the coordinator's tests can supply a double without modelling unrelated
 * vendor-resume overlay behaviour.
 */
export type LocalAgentNativeResumeRecordStore = Readonly<{
  readAgentNativeResumeRecord: (
    key: LocalAgentNativeResumeRecordKey,
  ) => Promise<LocalAgentNativeResumeRecordV1 | null>;
  writeAgentNativeResumeRecord: (
    input: LocalAgentNativeResumeRecordKey & Readonly<{
      identity: AgentNativeResumeIdentityV1 | null;
      departureSeqInclusive: number;
    }>,
  ) => Promise<void>;
}>;

/**
 * Provider-native open boundaries attach this marker only when they prove that
 * the requested native identity was not accepted. The host deliberately does
 * not infer this from ordinary startup, transport, or completion errors: those
 * failures do not authorize invalidating the machine-local return record.
 */
export function isAgentNativeResumeIdentityMismatchError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as Readonly<{ happierNativeResumeIdentityMismatch?: unknown }>)
      .happierNativeResumeIdentityMismatch === true;
}

/**
 * Resolved per invocation rather than at module load: `configuration` is the
 * daemon's own resolved state, and binding the directory at import time would
 * freeze it before the active server is known.
 */
export function createLocalAgentNativeResumeRecordStore(): LocalAgentNativeResumeRecordStore {
  return createLocalSessionHandoffMetadataStore({
    activeServerDir: configuration.activeServerDir,
  });
}

/**
 * This Account's settings as the daemon currently holds them.
 *
 * Resolved per invocation for the same reason as the record store: the active
 * Account and its settings revision both change under a long-lived daemon, and
 * binding either at import time would freeze the launch mode this decision is
 * supposed to observe. Unavailable settings read as `null`, which the eligibility
 * owner treats as no explicit enablement — fail closed, not fail open.
 */
export function readAgentNativeReturnAccountSettings(): Record<string, unknown> | null {
  return (getActiveAccountSettingsSnapshot()?.settings as Record<string, unknown> | undefined) ?? null;
}

/** Host-side containment and existence check for an Agent-proposed path. */
async function resolveContainedExistingFile(params: Readonly<{
  path: string;
  containmentRoot: string;
}>): Promise<string | null> {
  try {
    const [candidatePath, containmentRoot] = await Promise.all([
      realpath(params.path),
      realpath(params.containmentRoot),
    ]);
    const candidateRelativePath = relative(containmentRoot, candidatePath);
    if (
      candidateRelativePath === '..'
      || candidateRelativePath.startsWith(`..${sep}`)
      || isAbsolute(candidateRelativePath)
    ) {
      return null;
    }
    return (await stat(candidatePath)).isFile() ? candidatePath : null;
  } catch {
    return null;
  }
}

/**
 * The source Agent's own session log, when it kept one and the file is still
 * there — the path the bounded brief hands the target so it can reach history
 * the Happier transcript window could not carry.
 *
 * The incumbent persisted-path-first and catalog-derivation routes remain
 * available while supported Agents migrate atomically to the handoff callback.
 * When present, that callback interprets the opaque runtime descriptor and
 * proposes a candidate plus its containment root; the host alone resolves
 * symlinks, enforces containment, and checks that the result is a file.
 *
 * This is the POINTER, not a resume gate (`AM-24`): a missing log costs the seed
 * one line, never the native resume.
 *
 * MUST be called before the cutover projection: that projection clears the
 * declared log-path key and the vendor resume id from the current view, so after
 * it both routes answer `null`.
 */
export async function resolveObservableAgentNativeTranscriptPath(params: Readonly<{
  agentId: AgentId;
  metadata: Record<string, unknown>;
}>): Promise<string | null> {
  const identity = resolveAgentNativeResumeIdentityFromSessionMetadata(
    params.agentId,
    params.metadata,
  );
  if (!identity) return null;
  const incumbentCandidate = resolveAgentNativeTranscriptPathFromSessionMetadata(
    params.agentId,
    params.metadata,
  );
  if (incumbentCandidate) {
    return await stat(incumbentCandidate)
      .then((entry) => entry.isFile() ? incumbentCandidate : null)
      .catch(() => null);
  }
  const runtimeDescriptorV1 = readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata(
    params.metadata,
  );
  if (!runtimeDescriptorV1 || runtimeDescriptorV1.agentId !== params.agentId) {
    const derivedCandidate = await resolveAgentNativeSessionLogPathForAgent(params.agentId, {
      vendorResumeId: identity.vendorResumeId,
    }).catch(() => null);
    return derivedCandidate
      ? await stat(derivedCandidate).then((entry) => entry.isFile() ? derivedCandidate : null).catch(() => null)
      : null;
  }
  try {
    const currentRuntime = await getSessionHostBridge()
      .resolveCurrentExecutionSurfacesForCatalogAgent(params.agentId);
    const resolveCandidate = currentRuntime?.agentId === params.agentId
      ? currentRuntime.executionSurfaces.handoff?.resolveNativeTranscriptPathCandidate
      : null;
    const candidate = resolveCandidate
      ? await resolveCandidate({ identity, runtimeDescriptorV1 })
      : null;
    if (candidate) return await resolveContainedExistingFile(candidate);
    const derivedCandidate = await resolveAgentNativeSessionLogPathForAgent(params.agentId, {
      vendorResumeId: identity.vendorResumeId,
    }).catch(() => null);
    return derivedCandidate
      ? await stat(derivedCandidate).then((entry) => entry.isFile() ? derivedCandidate : null).catch(() => null)
      : null;
  } catch {
    return null;
  }
}

/**
 * The one usability decision, taken on the RETURN. It is deliberately not
 * shared with the departure capture any more: what this machine will launch
 * today cannot be allowed to erase what the departing Agent left behind.
 *
 * The candidate view is produced by the SAME projector the cutover commits, with
 * the same `clear` disposition, so eligibility is evaluated against the bytes
 * that will exist rather than against a hand-built approximation.
 */
function isAgentNativeReturnUsable(params: Readonly<{
  sourceMetadata: Record<string, unknown>;
  targetAgentId: AgentId;
  identity: AgentNativeResumeIdentityV1 | null;
  /**
   * Account settings for the launch-mode and enablement gates. Required rather
   * than optional: omitting them silently answered a different question than the
   * one the ordinary resume path answers.
   */
  accountSettings: Record<string, unknown> | null;
}>): boolean {
  if (!params.identity) return false;
  const candidateTargetView = projectCurrentAgentSessionView(params.sourceMetadata, {
    agentId: params.targetAgentId,
    nativeResumeIdentity: params.identity,
    runtimeDescriptor: null,
    agentScopedCurrentState: 'clear',
  });
  return evaluateVendorResumeEligibility({
    agentId: params.targetAgentId,
    metadata: candidateTargetView,
    accountSettings: params.accountSettings,
  }).eligible;
}

/**
 * Section 7.2 step 4 — before the source stop, while its identity is still the
 * committed current view.
 *
 * Three outcomes, and which one applies is decided by what the departing Agent
 * actually reached, never by what this machine would allow today:
 *
 * 1. **No structurally valid identity** — the current view names no conversation
 *    for this Agent, so any record an earlier departure left is removed. Leaving
 *    a stale one would let a later return resume a native session this Session
 *    no longer corresponds to, which is a correctness step, not cleanup.
 * 2. **The handed context was accepted, or none was handed** — the boundary
 *    advances to this departure's head. An Agent that took custody of the
 *    activation brief holds it, and everything after it in this Session is that
 *    Agent's own turns.
 * 3. **Context was handed and never accepted** — the boundary does NOT advance
 *    (`REQ-STATE-03`). The Agent reached no new boundary, so recording this head
 *    would hand a LATER return a delta measured against history the Agent never
 *    received, and nothing downstream could tell. Strict native failure is not
 *    inferred here: its host owner invalidates the offered local record before
 *    this capture can run, including when no replay seed exists.
 *
 * Replay-seed acceptance is read, not re-derived: an activation brief is retired
 * the instant the provider takes custody of the prompt it was prefixed to. It
 * bounds ordinary departure capture, but it deliberately cannot prove a strict
 * requested native identity resumed. This is why no proof file, probe, read-back,
 * TTL or generation appears here (`AM-24`): native identity success is proven by
 * the provider's strict completion boundary instead.
 *
 * `departureSeqInclusive` is the transcript head as it stands HERE, before the
 * stop. Deliberately not the post-stop head: a row that landed between this
 * point and the confirmed stop may never have been handed to the departing
 * Agent, and over-estimating the boundary skips it PERMANENTLY, while
 * under-estimating costs one re-replayed turn.
 *
 * The outcome never fails the transition. The record only decides whether a
 * FUTURE return is native; a write failure degrades that future return to fresh
 * plus the full replay, and rejecting a transition the user asked for over it
 * would be a worse trade. It is also why this returns `void`: there is no caller
 * decision to make.
 */
export async function captureDepartingAgentNativeResumeRecord(params: Readonly<{
  store: LocalAgentNativeResumeRecordStore;
  sessionId: string;
  sourceAgentId: AgentId;
  sourceMetadata: Record<string, unknown>;
  departureSeqInclusive: number;
}>): Promise<void> {
  const key: LocalAgentNativeResumeRecordKey = {
    happierSessionId: params.sessionId,
    agentId: params.sourceAgentId,
  };
  const write = async (
    identity: AgentNativeResumeIdentityV1 | null,
    departureSeqInclusive = params.departureSeqInclusive,
  ): Promise<void> => {
    await params.store.writeAgentNativeResumeRecord({
      ...key,
      identity,
      departureSeqInclusive,
    }).catch(() => {});
  };

  const identity = resolveAgentNativeResumeIdentityFromSessionMetadata(
    params.sourceAgentId,
    params.sourceMetadata,
  );
  if (!identity) {
    await write(null);
    return;
  }

  if (!isReplaySeedV1PendingProviderAcceptance(
    readReplaySeedV1FromMetadata(params.sourceMetadata),
  )) {
    await write(identity);
  }
}

/**
 * Strict native-resume failure has one local persistence consequence: remove
 * the exact offered identity before the current Session can be captured again.
 *
 * The existing (Session, Agent) record remains the owner. Matching the offered
 * vendor id prevents an older failure from erasing a newer successful return;
 * preserving its departure boundary keeps unrelated historical context intact.
 * There is intentionally no probe, generation, or read-back: the strict
 * provider completion already supplied the authoritative failure fact.
 */
export async function invalidateFailedAgentNativeReturnIdentity(params: Readonly<{
  store: LocalAgentNativeResumeRecordStore;
  sessionId: string;
  targetAgentId: AgentId;
  vendorResumeId: string;
}>): Promise<void> {
  const vendorResumeId = params.vendorResumeId.trim();
  if (!vendorResumeId) return;
  const key: LocalAgentNativeResumeRecordKey = {
    happierSessionId: params.sessionId,
    agentId: params.targetAgentId,
  };
  const recorded = await params.store.readAgentNativeResumeRecord(key).catch(() => null);
  if (recorded?.identity.vendorResumeId !== vendorResumeId) return;
  await params.store.writeAgentNativeResumeRecord({
    ...key,
    identity: null,
    departureSeqInclusive: recorded.departureSeqInclusive,
  }).catch(() => {});
}

/**
 * Whether this launch is the specific same-machine native return represented
 * by the local record. Ordinary `--resume` and restored sessions must not
 * clear their durable provider identity merely because they also carry a
 * resume id.
 */
export async function hasMatchingAgentNativeReturnIdentity(params: Readonly<{
  store: LocalAgentNativeResumeRecordStore;
  sessionId: string;
  targetAgentId: AgentId;
  vendorResumeId: string;
}>): Promise<boolean> {
  const vendorResumeId = params.vendorResumeId.trim();
  if (!vendorResumeId) return false;
  const record = await params.store.readAgentNativeResumeRecord({
    happierSessionId: params.sessionId,
    agentId: params.targetAgentId,
  }).catch(() => null);
  return record?.identity.vendorResumeId === vendorResumeId;
}

/**
 * Section 7.3 step 1 — resolved BEFORE the bounded brief is built.
 *
 * The order is a stated risk spot: choosing a narrower context lower bound and
 * only then discovering that native eligibility failed would omit history the
 * freshly-started target needs, invisibly. Resolving eligibility first means the
 * brief is always built against a decision that has already been made — and it
 * is why the departure bound leaves through THIS function rather than being read
 * from the store a second time. A target with no usable record hands the brief
 * no bound at all, which is the full replay a fresh target must get.
 */
export async function resolveAgentNativeReturnIdentity(params: Readonly<{
  store: LocalAgentNativeResumeRecordStore;
  sessionId: string;
  targetAgentId: AgentId;
  sourceMetadata: Record<string, unknown>;
  accountSettings: Record<string, unknown> | null;
}>): Promise<LocalAgentNativeResumeRecordV1 | null> {
  const record = await params.store.readAgentNativeResumeRecord({
    happierSessionId: params.sessionId,
    agentId: params.targetAgentId,
  }).catch(() => null);
  return isAgentNativeReturnUsable({
    sourceMetadata: params.sourceMetadata,
    targetAgentId: params.targetAgentId,
    identity: record?.identity ?? null,
    accountSettings: params.accountSettings,
  })
    ? record
    : null;
}
