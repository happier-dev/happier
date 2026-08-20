import {
  buildHappierReplayPromptFromDialog,
  planHappierReplayTranscriptCharBudget,
  HAPPIER_REPLAY_SEED_DISPATCH_RESERVED_CHARS,
  type HappierReplayContinuity,
  type HappierReplayRetrievalPointerV1,
  type HappierReplayStrategy,
  type HappierReplayDialogItem,
} from '@happier-dev/agents';
import type { LlmTaskRunnerConfigV1, SessionWorkStateV1 } from '@happier-dev/protocol';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import type { Credentials } from '@/persistence';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';

import { hydrateReplayDialogFromForkChain } from './hydrateReplayDialogFromForkChain';
import { hydrateVoiceReplayDialogFromTranscript } from './hydrateVoiceReplayDialogFromTranscript';
import { runReplaySummaryForDialog } from './summary/runReplaySummaryForDialog';

export type ReplaySeedSource =
  /** A different Session really is this seed's predecessor: fork, sourceContext, continue-with-replay. */
  | Readonly<{
      kind: 'fork_chain';
      previousSessionId: string;
      upToSeqInclusive?: number;
    }>
  /**
   * The in-place Agent transition: the seed is built from THIS Session's own
   * history because only the Agent running it changed.
   *
   * It is a source kind rather than a flag beside `fork_chain` so the framing
   * and the Session it is built from cannot disagree — the transition used to
   * pass its own Session as `previousSessionId`, and the seed then told the
   * target Agent it was continuing from a previous Session with that Session's
   * own id printed as its predecessor. Retrieval is identical: the same
   * fork-chain walk, from the same starting Session.
   */
  | Readonly<{
      kind: 'same_session_agent_change';
      sessionId: string;
      upToSeqInclusive?: number;
      /**
       * NATIVE RETURN only: the transcript head the target Agent had already
       * seen when it last ran this Session. The walk then starts just above it,
       * so the seed carries the delta rather than restating what the resumed
       * conversation still holds (`AM-26`).
       *
       * Absent is the FULL tail — the only thing a target with no departure
       * record can produce, and the only thing a FRESH target may ever get.
       */
      returningAgentLastSeenSeq?: number;
    }>
  | Readonly<{
      kind: 'voice_session.v1';
      previousSessionId: string;
      transcriptEpoch: number;
    }>;

/**
 * The fork-chain walk answers these; the voice hydrator does not, and neither
 * can claim the other's facts. Read defensively at the one seam where the two
 * shapes meet rather than widening the voice result with fields it has no way
 * to establish.
 */
function readHydratedSourceTitleText(value: unknown): string | null {
  const title = (value as { sourceTitleText?: unknown } | null)?.sourceTitleText;
  return typeof title === 'string' && title.trim().length > 0 ? title.trim() : null;
}

function readHydratedLastUserDialogItem(value: unknown): HappierReplayDialogItem | null {
  const item = (value as { lastUserDialogItem?: unknown } | null)?.lastUserDialogItem;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const text = (item as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  return item as HappierReplayDialogItem;
}

function readHydratedReachedSourceStart(value: unknown): boolean | null {
  const reached = (value as { reachedSourceStart?: unknown } | null)?.reachedSourceStart;
  return typeof reached === 'boolean' ? reached : null;
}

/** The Session whose history this seed replays, whatever the source kind calls it. */
function readSourceSessionId(source: ReplaySeedSource): string {
  return source.kind === 'same_session_agent_change' ? source.sessionId : source.previousSessionId;
}

/**
 * "There is nothing to replay" and "the bounded retrieval failed" are different
 * facts and must not collapse into one nullish answer.
 *
 * The distinction is load-bearing for the same-Session Agent transition, which
 * asks this question AFTER it has already stopped the source runtime. While
 * both meant `null`, a Session whose Agent had produced no dialog — a fresh
 * Session where the user switches Agent before sending anything — was stopped
 * and then failed with `context_unavailable`. An empty source is the trivially
 * satisfiable case: there is nothing to carry over, so nothing can fail.
 *
 * `hydrateReplayDialogFromForkChain` already separates them (`null` for a
 * failed hydration, `dialog: []` for a source with no dialog); this owner is
 * where the separation used to be lost.
 */
export type ReplaySeedDraftResolution =
  | Readonly<{
      status: 'seeded';
      seedDraft: string;
      dialog: readonly HappierReplayDialogItem[];
      summaryText: string | null;
      sourceCutoffSeqInclusive: number;
    }>
  /** Retrieval succeeded and the source carries no replayable dialog. */
  | Readonly<{ status: 'no_source_dialog' }>
  /** Bounded retrieval or decryption failed; what the source holds is unknown. */
  | Readonly<{ status: 'unavailable' }>;

export async function resolveReplaySeedDraft(params: Readonly<{
  credentials: Credentials;
  cwd: string;
  source: ReplaySeedSource;
  strategy: HappierReplayStrategy;
  /**
   * The released `recentMessagesCount` wire bound, or `null` for "no count
   * bound; the character budget is the bound".
   *
   * Internal callers pass `null`: a fixed row count in front of a character
   * budget makes the budget unreachable for short turns and redundant for long
   * ones, which is exactly how a 120k-character budget ended up carrying 25k.
   * The count survives only where it is a caller-supplied contract.
   */
  recentMessagesCount: number | null;
  maxSeedChars: number;
  /** Transcript page size for the backward walk (server caps one request at 500). */
  candidateLimit: number;
  maxTextChars?: number;
  /**
   * The departing Agent's work state, for the same-Session Agent transition whose cutover clears
   * the field (section 8). A replay-seeded NEW Session has no departing Agent and passes nothing.
   * The framing owner beneath bounds and escapes it inside the same total cap as the transcript.
   */
  workState?: SessionWorkStateV1 | null;
  /**
   * How the target Agent reaches the history this bounded seed cannot inline.
   *
   * Passed through rather than derived here: this owner is generic across every
   * Replay ingress and does not know WHO will read the seed, while the answer
   * depends entirely on the reader — which Agent it is, therefore which tool
   * channel it was given, and which machine it will run on. The one caller that
   * knows all three composes the pointer and hands it down.
   */
  retrieval?: HappierReplayRetrievalPointerV1 | null;
  summaryRunner?: LlmTaskRunnerConfigV1 | null;
  deps?: Readonly<{
    runReplaySummaryForDialog?: typeof runReplaySummaryForDialog;
  }>;
}>): Promise<ReplaySeedDraftResolution> {
  const sourceSessionId = readSourceSessionId(params.source);
  /**
   * The returning Agent's own boundary, normalized once. Only the same-Session
   * transition can carry one, and only on a native return: every other ingress
   * replays a Session the reader has never seen, so there is nothing it already
   * holds.
   */
  const returningAgentLastSeenSeq =
    params.source.kind === 'same_session_agent_change'
      && typeof params.source.returningAgentLastSeenSeq === 'number'
      && Number.isSafeInteger(params.source.returningAgentLastSeenSeq)
      && params.source.returningAgentLastSeenSeq >= 0
      ? params.source.returningAgentLastSeenSeq
      : null;
  const hydrated =
    params.source.kind !== 'voice_session.v1'
      ? await hydrateReplayDialogFromForkChain({
          credentials: params.credentials,
          startingSessionId: sourceSessionId,
          limit: params.candidateLimit,
          maxDialogItems: params.recentMessagesCount,
          maxTextChars: params.maxTextChars,
          wantSynopsisText: params.strategy === 'summary_plus_recent',
          // The framer answers how much room the transcript actually gets, so
          // the walk stops exactly where the framer would have started dropping
          // instead of fetching history that is then truncated a second time.
          // `historyIncomplete: true` costs one header line and is assumed here
          // so the plan is never larger than the real frame allows.
          planTranscriptCharBudget: ({ summaryText, sessionTitle }) => planHappierReplayTranscriptCharBudget({
            previousSessionId: sourceSessionId,
            continuity: params.source.kind === 'same_session_agent_change'
              ? 'same_session_agent_change'
              : 'previous_session',
            strategy: params.strategy,
            summaryText,
            sessionTitle,
            historyIncomplete: true,
            workState: params.workState ?? null,
            retrieval: params.retrieval ?? null,
            // The native-return boundary is FRAME text (the departure head and
            // the gap it names), so a plan that omits it under-measures the
            // frame, the walk overshoots, and the builder truncates a second
            // time — exactly what the comment above says this callback exists
            // to prevent. Same value the builder is handed below.
            returningAgentLastSeenSeq,
            maxPromptChars: params.maxSeedChars,
            reservedChars: HAPPIER_REPLAY_SEED_DISPATCH_RESERVED_CHARS,
          }),
          ...(typeof params.source.upToSeqInclusive === 'number' ? { upToSeqInclusive: params.source.upToSeqInclusive } : {}),
          ...(returningAgentLastSeenSeq === null ? {} : { afterSeqExclusive: returningAgentLastSeenSeq }),
        }).catch((error) => {
          if (isAuthenticationError(error)) throw error;
          return null;
        })
      : await hydrateVoiceReplayDialogFromTranscript({
          credentials: params.credentials,
          previousSessionId: params.source.previousSessionId,
          transcriptEpoch: params.source.transcriptEpoch,
          limit: params.candidateLimit,
          maxTextChars: params.maxTextChars,
        }).catch((error) => {
          if (isAuthenticationError(error)) throw error;
          return null;
        });

  if (!hydrated) return { status: 'unavailable' };
  // Only the retrieval owner can see a hole: every skip beneath it is a
  // `continue`. An empty dialog it ALSO reports as incomplete is therefore not
  // "the source carries nothing" — it is "we could not read what it carries",
  // and this consumer has already stopped the source before asking. Reporting
  // that as an empty source commits the switch and tells the reader everything
  // worked while the whole conversation is silently dropped.
  const historyIncomplete = (hydrated as { historyIncomplete?: boolean }).historyIncomplete === true;
  if (hydrated.dialog.length === 0) {
    return { status: historyIncomplete ? 'unavailable' : 'no_source_dialog' };
  }

  const summaryText = await (async () => {
    if (params.strategy !== 'summary_plus_recent') return null;
    const hydratedSynopsis = typeof hydrated.synopsisText === 'string' ? hydrated.synopsisText.trim() : '';
    if (hydratedSynopsis) return hydratedSynopsis;

    if (params.summaryRunner && resolveCliFeatureDecision({ featureId: 'execution.runs', env: process.env }).state === 'enabled') {
      try {
        const generated = await (params.deps?.runReplaySummaryForDialog ?? runReplaySummaryForDialog)({
          cwd: params.cwd,
          parentSessionId: sourceSessionId,
          runner: params.summaryRunner,
          dialog: hydrated.dialog,
        });
        const trimmed = typeof generated === 'string' ? generated.trim() : '';
        if (trimmed) return trimmed;
      } catch {
        // Best-effort only.
      }
    }

    return null;
  })();

  const effectiveStrategy: HappierReplayStrategy =
    params.strategy === 'summary_plus_recent' && summaryText ? 'summary_plus_recent' : 'recent_messages';

  const continuity: HappierReplayContinuity =
    params.source.kind === 'same_session_agent_change' ? 'same_session_agent_change' : 'previous_session';

  const seedDraft = buildHappierReplayPromptFromDialog({
    previousSessionId: sourceSessionId,
    continuity,
    // The framer states the boundary as a fact and, when the budget could not
    // carry the whole delta, names the exact seq range it is missing. A silent
    // truncation under a delta seed reads as "this IS everything that happened".
    returningAgentLastSeenSeq,
    strategy: effectiveStrategy,
    recentMessagesCount: params.recentMessagesCount,
    summaryText,
    dialog: hydrated.dialog,
    workState: params.workState ?? null,
    retrieval: params.retrieval ?? null,
    sessionTitle: readHydratedSourceTitleText(hydrated),
    lastUserInstruction: readHydratedLastUserDialogItem(hydrated),
    maxPromptChars: params.maxSeedChars,
    reservedChars: HAPPIER_REPLAY_SEED_DISPATCH_RESERVED_CHARS,
    // The retrieval owner is the only one that can see a hole; carrying the fact
    // here is what stops the seed from presenting partial history as the whole
    // conversation. A retrieval that cannot report it says nothing rather than
    // claiming completeness it never established.
    historyIncomplete,
    // A bounded walk that stopped on its budget is not a hole, but it is still
    // history the seed does not carry — and the framer can only see the items it
    // was GIVEN, so it cannot mark that loss unless it is told.
    windowTruncated: readHydratedReachedSourceStart(hydrated) === false,
  }).trim();

  // Retrieval succeeded; the rows simply carry nothing replayable. Nothing
  // failed, so this is an empty source rather than an unavailable one.
  if (!seedDraft) return { status: 'no_source_dialog' };

  return {
    status: 'seeded',
    seedDraft,
    dialog: hydrated.dialog,
    summaryText,
    sourceCutoffSeqInclusive: hydrated.sourceCutoffSeqInclusive,
  };
}
