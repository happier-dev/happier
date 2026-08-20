import {
  evaluateVendorResumeEligibility,
  projectCurrentAgentSessionView,
  resolveVendorResumeIdFromSessionMetadata,
  type AgentId,
} from '@happier-dev/agents';

import { configuration } from '@/configuration';
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
 * Two rules make this safe, and both are delegated rather than re-decided here:
 *
 * 1. **One eligibility owner.** Whether a recorded id may be resumed at all is
 *    decided by `evaluateVendorResumeEligibility` — the same owner the ordinary
 *    inactive-resume path consults — against the exact projected target view the
 *    cutover is about to commit, and against this Account's settings. Those
 *    settings carry the Agent's account-level enablement and its Codex backend
 *    mode, so an Agent whose native resume is switched off is refused there
 *    rather than reinterpreted here.
 * 2. **No pre-check of the conversation itself.** There is deliberately no
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
 * The one usability decision, shared by the departure capture and the return
 * resolution so the two can never disagree about what this machine will do.
 *
 * The candidate view is produced by the SAME projector the cutover commits, with
 * the same `clear` disposition, so eligibility is evaluated against the bytes
 * that will exist rather than against a hand-built approximation.
 */
export function isAgentNativeReturnUsable(params: Readonly<{
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
 * An INELIGIBLE source must remove any record it left behind on an earlier
 * departure. Leaving a stale one would let a later return resume a native
 * session this Session no longer corresponds to, so the removal is a correctness
 * step, not cleanup.
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
  accountSettings: Record<string, unknown> | null;
  departureSeqInclusive: number;
}>): Promise<void> {
  const identity = resolveAgentNativeResumeIdentity(params.sourceAgentId, params.sourceMetadata);
  const usable = isAgentNativeReturnUsable({
    sourceMetadata: params.sourceMetadata,
    targetAgentId: params.sourceAgentId,
    identity,
    accountSettings: params.accountSettings,
  });
  await params.store.writeAgentNativeResumeRecord({
    happierSessionId: params.sessionId,
    agentId: params.sourceAgentId,
    identity: usable ? identity : null,
    departureSeqInclusive: params.departureSeqInclusive,
  }).catch(() => {});
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
