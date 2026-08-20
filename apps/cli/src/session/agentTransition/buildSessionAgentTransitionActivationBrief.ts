import { stat } from 'node:fs/promises';

import { readDisplayableSessionWorkStateV1 } from '@happier-dev/protocol';
import {
  AGENT_IDS,
  resolveAgentNativeTranscriptPathFromSessionMetadata,
  resolveVendorResumeIdFromSessionMetadata,
  type AgentId,
} from '@happier-dev/agents';

import { resolveAgentNativeSessionLogPathThroughCatalog } from '@/backends/catalog';

import {
  buildSessionTranscriptRetrievalInvocation,
} from '@/agent/tools/happierTools/runtime/buildSessionTranscriptRetrievalInvocation';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { resolveReplaySeedDraft, type ReplaySeedDraftResolution } from '@/session/replay/resolveReplaySeedDraft';

/**
 * A recorded id the incumbent catalog still knows.
 *
 * Both ids reach this owner from a durable divider, so either may name an Agent
 * that has since been removed. Narrowing against the canonical list — rather
 * than a second list of this module's own — is what lets an unknown id degrade
 * to "no native transcript path" instead of throwing on a historical boundary.
 */
function asKnownAgentId(agentId: string): AgentId | null {
  return (AGENT_IDS as readonly string[]).includes(agentId) ? agentId as AgentId : null;
}

/**
 * The source Agent's own session log, before it is checked for existence.
 *
 * Two declarations can answer, and neither names an Agent here:
 *
 * 1. **A persisted path** — the catalog-declared continuity-proof slot
 *    (`vendorResumeContinuityProofField`; Claude declares `claudeTranscriptPath`).
 *    The Agent wrote the path into its own metadata, so reading it is the whole
 *    derivation, and it wins whenever it is there: it is what that Agent itself
 *    recorded for this exact Session.
 * 2. **A declared derivation** — the provider-owned
 *    `resolveAgentNativeSessionLogPath` catalog hook, for an Agent that persists
 *    no path but can still find one from the vendor resume id (Codex names its
 *    rollout file after the thread id). Without this, a Codex source handed over
 *    no log at all, because "declares no proof field" was being read as "keeps no
 *    log".
 */
async function resolveNativeTranscriptPathCandidate(
  sourceAgentId: AgentId,
  departingAgentCurrentView: Record<string, unknown>,
): Promise<string | null> {
  const persisted = resolveAgentNativeTranscriptPathFromSessionMetadata(
    sourceAgentId,
    departingAgentCurrentView,
  );
  if (persisted !== null) return persisted;
  const vendorResumeId = resolveVendorResumeIdFromSessionMetadata(
    sourceAgentId,
    departingAgentCurrentView,
  );
  if (!vendorResumeId) return null;
  return await resolveAgentNativeSessionLogPathThroughCatalog(sourceAgentId, { vendorResumeId })
    .catch(() => null);
}

/**
 * The bounded backward context pass (section 9), as ONE owner.
 *
 * The transition owns WHEN it runs — after the confirmed stop, against the
 * transcript head captured at that instant — and what an unavailable result
 * means. The retrieval, character budget, escaping and framing belong to the
 * canonical Replay seed owner beneath it, and nothing is re-implemented here.
 *
 * It is a module rather than an inline block because it now has TWO callers
 * that must not disagree: the transition itself, and the read-only preview that
 * rebuilds what a divider stands for (`session.agentTransition.briefPreview`).
 * A preview built by a second composition would be free to show something the
 * target Agent was never sent, which is worse than showing nothing.
 */
export async function buildSessionAgentTransitionActivationBrief(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  /**
   * Reads the departing Agent's own recorded native transcript path — out of
   * `departingAgentCurrentView` and nowhere else, because after the cutover the
   * catalog-declared proof slot names whichever Agent republished it.
   */
  sourceAgentId: string;
  /** Decides which retrieval invocation the incoming Agent can actually run. */
  targetAgentId: string;
  workspacePath: string;
  /**
   * The departing Agent's OWN current view, as it stood while that Agent was
   * still the Session's Agent — i.e. before the cutover projection cleared it.
   * The only basis on which its runtime projections may be read: its tracked
   * work (`sessionWorkStateV1`) and its native session log are Agent-scoped
   * current state, so the same durable keys hold the NEXT Agent's values once
   * that Agent republishes them.
   *
   * `null` when the caller genuinely has no such view. The read-only rebuild
   * behind the transcript card runs long after the cutover and the divider
   * records only the cutoff and the Agent pair, so nothing recovers what the
   * departing Agent held at that instant. Those components are then OMITTED
   * rather than re-read from today's view: a surface whose whole claim is "this
   * is what was handed over" must not fill the gap with the incumbent's live
   * state, and the card states the omission instead.
   */
  departingAgentCurrentView: Record<string, unknown> | null;
  /**
   * The bound the pass runs to. For the transition this is head U captured
   * after the confirmed stop; for the read-only preview it is the cutoff the
   * divider recorded, which is that same head replayed.
   */
  transcriptHeadSeqInclusive: number;
  /**
   * NATIVE RETURN only: the transcript head the TARGET Agent had already seen
   * when it last ran this Session, from its machine-local departure record
   * (`AM-26`). The pass then carries only the delta, and the seed states the
   * boundary rather than restating history the resumed conversation holds.
   *
   * `null`/absent is the FULL tail, which is the only thing a target with no
   * record — including every target that never ran this Session — may get. The
   * read-only preview also passes nothing: the divider records the cutoff and
   * the Agent pair, never what the target already held.
   */
  returningAgentLastSeenSeq?: number | null;
}>): Promise<ReplaySeedDraftResolution> {
  /**
   * How the target reaches the history this bounded seed cannot inline.
   *
   * The seed is a TAIL, and on a real Session that tail is a small fraction of
   * the conversation. The target CAN read the rest — the transcript action is on
   * its own tool surface — but nothing in the seed said so, said where, or said
   * which slice it was already holding, so it either worked from the tail alone
   * or paged the transcript from the start and re-read its own prompt.
   *
   * Composed here because this is the one place that knows all three facts the
   * two routes depend on: which Agent will read the seed, that the target runs
   * on THIS machine, and whether the departing Agent's own view is still in
   * hand. They are complementary, so neither is suppressed because the other
   * resolved — but the native half exists only while that view does, because the
   * log path is the departing Agent's own current state and the key outlives its
   * owner.
   */
  const departingAgentCurrentView = params.departingAgentCurrentView;
  const sourceAgentId = asKnownAgentId(params.sourceAgentId);
  const nativeTranscriptPathCandidate = departingAgentCurrentView === null || sourceAgentId === null
    ? null
    : await resolveNativeTranscriptPathCandidate(sourceAgentId, departingAgentCurrentView);
  // Agents prune and rotate their logs, so a recorded or derived path routinely
  // outlives its file; naming one that is gone spends the reader's turn on nothing.
  const nativeTranscriptPath = nativeTranscriptPathCandidate === null
    ? null
    : await stat(nativeTranscriptPathCandidate)
      .then((entry) => (entry.isFile() ? nativeTranscriptPathCandidate : null))
      .catch(() => null);
  const renderRetrievalInvocation = buildSessionTranscriptRetrievalInvocation({
    agentId: params.targetAgentId,
    sessionId: params.sessionId,
    directory: params.workspacePath,
  });
  const retrieval = renderRetrievalInvocation !== null || nativeTranscriptPath !== null
    ? {
      sessionId: params.sessionId,
      renderInvocation: renderRetrievalInvocation,
      nativeTranscriptPath,
    }
    : null;

  return await resolveReplaySeedDraft({
    credentials: params.credentials,
    cwd: params.workspacePath,
    source: {
      // The Session is the same one; only the Agent running it changed. Asking
      // through `fork_chain` passed this Session as its own `previousSessionId`,
      // and the seed then told the target Agent it was continuing from a
      // previous Happy session — printing this Session's id as its predecessor.
      // Retrieval is identical; only the framing the seed can honestly make
      // differs.
      kind: 'same_session_agent_change',
      sessionId: params.sessionId,
      upToSeqInclusive: params.transcriptHeadSeqInclusive,
      ...(typeof params.returningAgentLastSeenSeq === 'number'
        ? { returningAgentLastSeenSeq: params.returningAgentLastSeenSeq }
        : {}),
    },
    strategy: 'recent_messages',
    // No count bound: the brief is bounded by CHARACTERS (section 9.2).
    recentMessagesCount: null,
    maxSeedChars: configuration.replaySeedMaxChars,
    candidateLimit: configuration.replaySeedCandidateLimit,
    // Section 8's other half. The cutover projection clears `sessionWorkStateV1` — the target
    // republishes its own — and the items are a structured projection rather than transcript
    // prose, so the departing Agent's live view is the last reader that can carry the in-flight
    // plan across. Read through the canonical display-safe reader: a malformed projection is no
    // snapshot, not a raw object forwarded into another Agent's prompt. With no such view there is
    // nothing to carry: the same key now holds whatever the CURRENT Agent published, which never
    // crossed this boundary.
    workState: departingAgentCurrentView === null
      ? null
      : readDisplayableSessionWorkStateV1(departingAgentCurrentView.sessionWorkStateV1),
    retrieval,
  }).catch((error: unknown): ReplaySeedDraftResolution => {
    if (isAuthenticationError(error)) throw error;
    return { status: 'unavailable' };
  });
}
