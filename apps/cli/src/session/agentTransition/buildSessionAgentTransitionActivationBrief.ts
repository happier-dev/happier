import {
  HappierReplayWritableMaxSeedCharsSchema,
  readSessionWorkStateV1FromMetadata,
} from '@happier-dev/protocol';

import { buildSessionTranscriptRetrievalInvocation } from '@/agent/tools/happierTools/runtime/buildSessionTranscriptRetrievalInvocation';
import { resolveAgentDisplayTitle } from '@/agent/catalog/agentDisplayTitle';
import type { ReplaySeedV1 } from '@/agent/runtime/replaySeed/replaySeedV1';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
  resolveReplaySeedDraft,
  type ReplaySeedDraftResolution,
} from '@/session/replay/resolveReplaySeedDraft';

import { resolveObservableAgentNativeTranscriptPath } from './agentNativeReturn';

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The Account's Replay seed budget, or `null` when no Account snapshot states a
 * usable one.
 *
 * Fork and resume already honour `sessionReplayMaxSeedChars`: their UI entry
 * points resolve it and send it as the caller-supplied `maxSeedChars`, which the
 * seed owners take in preference to the daemon default. The in-place transition
 * has no such caller — neither the transition request nor the read-only brief
 * preview carries a budget — so it used the daemon value alone and the number a
 * user set in Settings did not apply to switching Agent in place.
 *
 * Read HERE rather than at the two callers because they must not disagree: the
 * preview's whole claim is that it shows what the target Agent was sent, and a
 * rebuild against a different budget would quietly break that.
 *
 * Parsed through the shared budget owner rather than a range restated here, so
 * the floor beneath which the seed builder deliberately produces NO seed stays
 * stated in exactly one place.
 */
function readAccountReplayMaxSeedChars(): number | null {
  const settings = getActiveAccountSettingsSnapshot()?.settings as
    | { sessionReplayMaxSeedChars?: unknown }
    | undefined;
  const parsed = HappierReplayWritableMaxSeedCharsSchema.safeParse(settings?.sessionReplayMaxSeedChars);
  return parsed.success ? parsed.data : null;
}

/**
 * `seed: null` is the EMPTY source, not a failure: a Session whose Agent has
 * produced no dialog has nothing to carry over, which is the trivially
 * satisfiable case. `unavailable` is reserved for a bounded retrieval that
 * genuinely failed — the only one that may fail a transition whose source is
 * already stopped.
 */
export type SessionAgentTransitionActivationBriefV1 =
  | Readonly<{ status: 'available'; seed: ReplaySeedV1 | null }>
  | Readonly<{ status: 'unavailable' }>;

/**
 * The bounded backward context pass (section 9). The transition owns WHEN it
 * runs — after the confirmed stop, against the transcript head captured at that
 * instant — and what an unavailable result means; the retrieval, budget,
 * escaping and framing belong to the canonical Replay seed owner beneath it.
 *
 * The seam stays injectable for tests, but its DEFAULT must build a real brief.
 * A default that seeds nothing is not "a tree where the context owner has not
 * landed": the RPC handler injects no deps, so that default IS the shipped
 * behaviour, and the product would commit the target Agent with none of the
 * conversation it promises to carry over — silently, with an `accepted` result.
 */
export type BuildSessionAgentTransitionActivationBrief = (
  input: Readonly<{
    credentials: StoredCredentials;
    sessionId: string;
    /**
     * The bound the pass runs to. For the transition this is head U captured
     * after the confirmed stop; for the read-only preview it is the cutoff the
     * divider recorded, which is that same head replayed.
     */
    transcriptHeadSeqInclusive: number;
    /**
     * The Session's own facts — the workspace path the bounded pass and the
     * retrieval pointer both need. These read the same whenever they are read,
     * which is why they are separate from the view below.
     */
    sourceMetadata: Record<string, unknown>;
    /**
     * The departing Agent's OWN current view, as it stood while that Agent was
     * still the Session's Agent — i.e. before the cutover projection cleared it.
     * The only basis on which its runtime projections may be read: its tracked
     * work (`runtime.workState`) and its native session log (the catalog-declared
     * log-path slot) are Agent-scoped current state, so the same durable keys
     * hold the NEXT Agent's values once that Agent republishes them.
     *
     * `null` when the caller genuinely has no such view. The read-only rebuild
     * behind the transcript card runs long after the cutover and the divider
     * records only the cutoff and the Agent pair, so nothing recovers what the
     * departing Agent held at that instant. Those components are then OMITTED
     * rather than re-read from today's view: a surface whose whole claim is
     * "this is what was handed over" must not fill the gap with the incumbent's
     * live state, and the card states the omission instead.
     */
    departingAgentCurrentView: Record<string, unknown> | null;
    /**
     * The Agent this brief is ADDRESSED to, which decides how it can be told to
     * read the history the brief could not inline: the two tool channels are
     * mutually exclusive at runtime, so the wrong one is a false instruction
     * rather than a degraded one.
     *
     * Optional because a caller that cannot name the target honestly has none to
     * name; the seed then carries no retrieval pointer rather than a guessed one.
     */
    targetAgentId?: string | null;
    /**
     * The Agent that was RUNNING the Session, whose own session log the brief may
     * point at. Read through the catalog-declared log-path slot, and only out of
     * `departingAgentCurrentView` — after the cutover the slot names whichever
     * Agent republished it, which is a different conversation.
     */
    sourceAgentId?: string | null;
    /**
     * On a NATIVE RETURN only: the transcript head the target Agent had already
     * seen when it last ran this Session, so the replay carries the delta rather
     * than restating a conversation the resumed Agent still holds (`AM-26`).
     *
     * `null`/omitted is the FULL replay, and it is the only thing a fresh target
     * can produce: the bound comes from that Agent's own departure record, so a
     * target that never ran here has none. That is what makes starving a fresh
     * target structurally impossible rather than merely avoided.
     */
    returningAgentLastSeenSeq?: number | null;
  }>,
) => Promise<SessionAgentTransitionActivationBriefV1> | SessionAgentTransitionActivationBriefV1;

/**
 * Section 9.1, through the one owner that already enforces section 9.2: the
 * configured total cap, the untrusted-history escaping, the omission marker and
 * the header framing all live in `buildHappierReplayPromptFromDialog` beneath
 * `resolveReplaySeedDraft`. Nothing is re-implemented here and no local
 * maximum competes with `configuration.replaySeedMaxChars`.
 *
 * `recent_messages` is deliberate: `summary_plus_recent` would introduce an LLM
 * summary run into a window where the source is already stopped and the user is
 * waiting, and section 9.2 forbids a new summary owner for this path.
 *
 * It lives in its own module because it now has TWO callers that must not
 * disagree: the transition itself, and the read-only preview that rebuilds what
 * a divider stands for (`session.agentTransition.briefPreview`). A preview built
 * by a second composition would be free to show something the target Agent was
 * never sent, which is worse than showing nothing.
 */
export const buildBoundedActivationBrief: BuildSessionAgentTransitionActivationBrief = async (input) => {
  const cwd = readNonEmptyString(input.sourceMetadata.path);
  if (!cwd) return { status: 'unavailable' };

  /**
   * Section 9's other half: the seed is a bounded TAIL, and on a real Session
   * that tail is a small fraction of the conversation. The observed window
   * carried 500 rows against a 120 000 character budget while the user's last
   * instruction sat 1 154 rows earlier — reachable the whole time, because the
   * transcript action is on the target's own tool surface, but never mentioned.
   *
   * Both routes are composed here because this is the one place that knows all
   * three facts they depend on: which Agent will read the seed, that the target
   * runs on THIS machine (the transition refuses a cross-machine switch), and
   * whether the departing Agent's own view is still in hand. They are
   * complementary, so neither is suppressed because the other resolved — but the
   * native half exists only while that view does, because the log path is the
   * departing Agent's own current state and the key outlives its owner.
   */
  const targetAgentId = readNonEmptyString(input.targetAgentId);
  const renderInvocation = targetAgentId === null
    ? null
    : buildSessionTranscriptRetrievalInvocation({
      agentId: targetAgentId,
      sessionId: input.sessionId,
      directory: cwd,
    });
  const sourceAgentId = readNonEmptyString(input.sourceAgentId);
  const sourceAgentLabel = sourceAgentId === null ? null : resolveAgentDisplayTitle(sourceAgentId);
  const departingAgentCurrentView = input.departingAgentCurrentView;
  const nativeTranscriptPath = departingAgentCurrentView !== null
    && sourceAgentId !== null
    ? await resolveObservableAgentNativeTranscriptPath({
      agentId: sourceAgentId,
      metadata: departingAgentCurrentView,
    })
    : null;
  const retrieval = renderInvocation !== null || nativeTranscriptPath !== null
    ? { sessionId: input.sessionId, renderInvocation, nativeTranscriptPath }
    : null;

  const resolved = await resolveReplaySeedDraft({
    credentials: input.credentials,
    cwd,
    source: {
      // The Session is the same one; only the Agent running it changed. Asking
      // through `fork_chain` passed this Session as its own `previousSessionId`,
      // and the seed then told the target Agent it was continuing from a
      // previous Happy session — printing this Session's id as its predecessor.
      // Retrieval is identical; only the framing the seed can honestly make
      // differs.
      kind: 'same_session_agent_change',
      sessionId: input.sessionId,
      // Head U, captured after the confirmed stop. A row accepted later stays
      // canonical history even though it missed this brief.
      upToSeqInclusive: input.transcriptHeadSeqInclusive,
      ...(typeof input.returningAgentLastSeenSeq === 'number'
        ? { returningAgentLastSeenSeq: input.returningAgentLastSeenSeq }
        : {}),
    },
    strategy: 'recent_messages',
    // No count bound: the brief is bounded by CHARACTERS (section 9.2). The
    // page-size knob was standing in as a message count here, which capped the
    // window at 500 turns in front of a 120k-character budget.
    recentMessagesCount: null,
    // The same precedence the fork path applies: caller-supplied budget →
    // daemon env → default. The Account preference IS the supplied value here,
    // because this path has no wire field to carry one.
    maxSeedChars: readAccountReplayMaxSeedChars() ?? configuration.replaySeedMaxChars,
    candidateLimit: configuration.replaySeedCandidateLimit,
    sourceAgentLabel,
    // Section 8's other half. The cutover projection clears `sessionWorkStateV1`
    // — the target republishes its own — and the items are a structured
    // projection rather than transcript prose, so the departing Agent's live
    // view is the last reader that can carry the in-flight plan across. Read
    // through the canonical display-safe reader: a malformed projection is no
    // snapshot, not a raw object forwarded into another Agent's prompt. With no
    // such view there is nothing to carry: the same key now holds whatever the
    // CURRENT Agent published, which never crossed this boundary.
    workState: departingAgentCurrentView === null
      ? null
      : readSessionWorkStateV1FromMetadata(departingAgentCurrentView),
    retrieval,
  }).catch((): ReplaySeedDraftResolution => ({ status: 'unavailable' }));

  // An empty source is AVAILABLE with nothing to carry. Collapsing it into
  // `unavailable` stopped the source of a fresh Session and then failed the
  // switch with `context_unavailable` — the most likely first moment a new user
  // tries the feature, and the one case that trivially cannot fail.
  if (resolved.status === 'no_source_dialog') return { status: 'available', seed: null };
  if (resolved.status !== 'seeded') return { status: 'unavailable' };

  return {
    status: 'available',
    seed: {
      v: 1,
      seedText: resolved.seedDraft,
      sourceSessionId: input.sessionId,
      sourceCutoffSeqInclusive: resolved.sourceCutoffSeqInclusive,
      createdAtMs: Date.now(),
    },
  };
};
