import {
  buildHappierReplayPromptFromDialog,
  type HappierReplayContinuity,
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
    }>
  | Readonly<{
      kind: 'voice_session.v1';
      previousSessionId: string;
      transcriptEpoch: number;
    }>;

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
  recentMessagesCount: number;
  maxSeedChars: number;
  candidateLimit: number;
  maxTextChars?: number;
  /**
   * The departing Agent's work state, for the same-Session Agent transition whose cutover clears
   * the field (section 8). A replay-seeded NEW Session has no departing Agent and passes nothing.
   * The framing owner beneath bounds and escapes it inside the same total cap as the transcript.
   */
  workState?: SessionWorkStateV1 | null;
  summaryRunner?: LlmTaskRunnerConfigV1 | null;
  deps?: Readonly<{
    runReplaySummaryForDialog?: typeof runReplaySummaryForDialog;
  }>;
}>): Promise<ReplaySeedDraftResolution> {
  const sourceSessionId = readSourceSessionId(params.source);
  const hydrated =
    params.source.kind !== 'voice_session.v1'
      ? await hydrateReplayDialogFromForkChain({
          credentials: params.credentials,
          startingSessionId: sourceSessionId,
          limit: params.candidateLimit,
          maxTextChars: params.maxTextChars,
          wantSynopsisText: params.strategy === 'summary_plus_recent',
          ...(typeof params.source.upToSeqInclusive === 'number' ? { upToSeqInclusive: params.source.upToSeqInclusive } : {}),
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
  if (hydrated.dialog.length === 0) return { status: 'no_source_dialog' };

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
    strategy: effectiveStrategy,
    recentMessagesCount: params.recentMessagesCount,
    summaryText,
    dialog: hydrated.dialog,
    workState: params.workState ?? null,
    maxPromptChars: params.maxSeedChars,
    // The retrieval owner is the only one that can see a hole; carrying the fact
    // here is what stops the seed from presenting partial history as the whole
    // conversation. A retrieval that cannot report it says nothing rather than
    // claiming completeness it never established.
    historyIncomplete: (hydrated as { historyIncomplete?: boolean }).historyIncomplete === true,
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
