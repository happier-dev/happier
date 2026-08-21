import {
  evaluateVendorResumeEligibility,
  projectCurrentAgentSessionView,
  resolveVendorResumeIdFromSessionMetadata,
  type AgentId,
} from '@happier-dev/agents';

import { configuration } from '@/configuration';
import {
  isReplaySeedV1PendingProviderAcceptance,
  readReplaySeedV1FromMetadata,
} from '@/agent/runtime/replaySeed/replaySeedV1';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
  createLocalAgentNativeResumeRecordStoreAt,
  type LocalAgentNativeResumeIdentityV1,
  type LocalAgentNativeResumeRecordKey,
  type LocalAgentNativeResumeRecordV1,
} from '@/session/handoff/metadata/localAgentNativeResumeRecordStore';

/**
 * Same-machine native return (sections 6.5, 7.2 step 4, 7.3 step 1).
 *
 * Switching Agent A away and later back is the case this exists for. Without it
 * the returning Agent always starts a brand-new native conversation seeded only
 * by the bounded brief; with it, the Agent resumes the exact native session it
 * left, and the brief carries only what happened while it was gone (`AM-26`).
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
 *    this Account's settings. Those settings carry the Agent's account-level
 *    enablement and its Codex backend mode, and both are transient and
 *    reversible: they say what this machine will do NOW, never what the
 *    departing conversation was. So the DEPARTURE records a structurally valid
 *    identity regardless of them, and this decision is taken on the way back.
 *    Evaluating it at capture wrote `identity: null` for an Agent the user had
 *    temporarily switched off, deleting the only copy of that continuity, and
 *    re-enabling the Agent afterwards could not recover it.
 * 2. **The accepted-context boundary owns the advance.** The recorded seq moves
 *    forward only once the provider accepted the context this activation handed
 *    the Agent (`REQ-STATE-03`), and an identity that was offered and reached
 *    no acceptance is invalidated rather than re-offered. Acceptance is not
 *    re-derived here: it is the replay seed's own retirement, the same fact the
 *    prompt owner settles on provider acceptance.
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
 *
 * The departing Agent's own session-log POINTER is deliberately NOT resolved
 * here: `buildSessionAgentTransitionActivationBrief` already owns that
 * derivation (persisted catalog slot, then the catalog hook, then an existence
 * check), and a second resolver would be a competing owner for one fact.
 */

/**
 * The record surface this module needs. Narrower than the store itself so the
 * coordinator's tests can supply a double for the one genuine boundary here —
 * protected files on disk — while the eligibility decision and the projection
 * beneath it run for real.
 */
export type LocalAgentNativeResumeRecordStore = Readonly<{
  readAgentNativeResumeRecord: (
    key: LocalAgentNativeResumeRecordKey,
  ) => Promise<LocalAgentNativeResumeRecordV1 | null>;
  writeAgentNativeResumeRecord: (
    input: LocalAgentNativeResumeRecordKey & Readonly<{
      identity: LocalAgentNativeResumeIdentityV1 | null;
      departureSeqInclusive: number;
    }>,
  ) => Promise<void>;
}>;

/**
 * Resolved per invocation rather than at module load: `configuration` is the
 * daemon's own resolved state, and binding the directory at import time would
 * freeze it before the active server is known.
 */
export function createLocalAgentNativeResumeRecordStore(): LocalAgentNativeResumeRecordStore {
  return createLocalAgentNativeResumeRecordStoreAt({
    activeServerDir: configuration.activeServerDir,
  });
}

/**
 * This Account's settings as the daemon currently holds them.
 *
 * Resolved per invocation for the same reason as the record store: the active
 * Account and its settings revision both change under a long-lived daemon, and
 * binding either at import time would freeze the enablement this decision is
 * supposed to observe. Unavailable settings read as `null`, which the
 * eligibility owner treats as no explicit enablement — fail closed, not fail
 * open.
 */
export function readAgentNativeReturnAccountSettings(): Record<string, unknown> | null {
  return (getActiveAccountSettingsSnapshot()?.settings as Record<string, unknown> | undefined) ?? null;
}

/** The Agent's own conversation id as its catalog declares the slot, or `null`. */
function resolveAgentNativeResumeIdentity(
  agentId: AgentId,
  metadata: Record<string, unknown>,
): LocalAgentNativeResumeIdentityV1 | null {
  const vendorResumeId = resolveVendorResumeIdFromSessionMetadata(agentId, metadata);
  return vendorResumeId ? { v: 1, vendorResumeId } : null;
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
  identity: LocalAgentNativeResumeIdentityV1 | null;
  /**
   * Account settings for the enablement gates. Required rather than optional:
   * omitting them silently answered a different question than the one the
   * ordinary resume path answers.
   */
  accountSettings: Record<string, unknown> | null;
}>): boolean {
  if (!params.identity) return false;
  const candidateTargetView = projectCurrentAgentSessionView({
    metadata: params.sourceMetadata,
    target: {
      agentId: params.targetAgentId,
      // The candidate view is EVALUATED, never committed, and no eligibility
      // rule reads a timestamp — so a fixed value keeps this decision
      // deterministic instead of borrowing the clock.
      updatedAtMs: 0,
    },
    nativeResumeId: params.identity.vendorResumeId,
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
 *    received, and nothing downstream could tell. If the identity still in the
 *    view is the one this machine RESTORED from the record, that strict native
 *    return also demonstrably failed before acceptance, so the identity is
 *    invalidated rather than left to be re-offered unchanged on the next switch.
 *
 * Acceptance is read, not re-derived: an activation brief is retired the instant
 * the provider takes custody of the prompt it was prefixed to, so the seed slot
 * the cutover itself wrote IS the durable acceptance fact, shared with the
 * prompt owner's own settlement rather than duplicated by a second signal. This
 * is why no proof file, probe, read-back, TTL or generation appears here
 * (`AM-24`): the one thing that had to be known is already written down.
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
    identity: LocalAgentNativeResumeIdentityV1 | null,
    departureSeqInclusive = params.departureSeqInclusive,
  ): Promise<void> => {
    await params.store.writeAgentNativeResumeRecord({
      ...key,
      identity,
      departureSeqInclusive,
    }).catch(() => {});
  };

  const identity = resolveAgentNativeResumeIdentity(params.sourceAgentId, params.sourceMetadata);
  if (!identity) {
    await write(null);
    return;
  }

  if (!isReplaySeedV1PendingProviderAcceptance(
    readReplaySeedV1FromMetadata(params.sourceMetadata),
  )) {
    await write(identity);
    return;
  }

  // Handed context, never accepted. The read is what separates "this machine
  // offered that id and the resume failed" from "the Agent published an id of
  // its own": only the first may invalidate, and the second must leave an
  // earlier, genuinely reached boundary exactly where it is.
  const recorded = await params.store.readAgentNativeResumeRecord(key).catch(() => null);
  if (recorded?.identity?.vendorResumeId === identity.vendorResumeId) {
    // A failed strict return makes this identity unusable, but the accepted
    // replay boundary belongs to its earlier successful departure. Do not
    // advance that boundary with history the resumed Agent never accepted.
    await write(null, recorded.departureSeqInclusive);
  }
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
