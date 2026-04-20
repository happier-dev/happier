import { buildHappierReplayPromptFromDialog, type HappierReplayStrategy, type HappierReplayDialogItem } from '@happier-dev/agents';
import type { LlmTaskRunnerConfigV1 } from '@happier-dev/protocol';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import type { Credentials } from '@/persistence';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';

import { hydrateReplayDialogFromForkChain } from './hydrateReplayDialogFromForkChain';
import { hydrateVoiceReplayDialogFromTranscript } from './hydrateVoiceReplayDialogFromTranscript';
import { runReplaySummaryForDialog } from './summary/runReplaySummaryForDialog';

export type ReplaySeedSource =
  | Readonly<{
      kind: 'fork_chain';
      previousSessionId: string;
      upToSeqInclusive?: number;
    }>
  | Readonly<{
      kind: 'voice_session.v1';
      previousSessionId: string;
      transcriptEpoch: number;
    }>;

export async function resolveReplaySeedDraft(params: Readonly<{
  credentials: Credentials;
  cwd: string;
  source: ReplaySeedSource;
  strategy: HappierReplayStrategy;
  recentMessagesCount: number;
  maxSeedChars: number;
  candidateLimit: number;
  maxTextChars?: number;
  summaryRunner?: LlmTaskRunnerConfigV1 | null;
  deps?: Readonly<{
    runReplaySummaryForDialog?: typeof runReplaySummaryForDialog;
  }>;
}>): Promise<{
  seedDraft: string;
  dialog: readonly HappierReplayDialogItem[];
  summaryText: string | null;
  sourceCutoffSeqInclusive: number;
} | null> {
  const hydrated =
    params.source.kind === 'fork_chain'
      ? await hydrateReplayDialogFromForkChain({
          credentials: params.credentials,
          startingSessionId: params.source.previousSessionId,
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

  if (!hydrated || hydrated.dialog.length === 0) return null;

  const summaryText = await (async () => {
    if (params.strategy !== 'summary_plus_recent') return null;
    const hydratedSynopsis = typeof hydrated.synopsisText === 'string' ? hydrated.synopsisText.trim() : '';
    if (hydratedSynopsis) return hydratedSynopsis;

    if (params.summaryRunner && resolveCliFeatureDecision({ featureId: 'execution.runs', env: process.env }).state === 'enabled') {
      try {
        const generated = await (params.deps?.runReplaySummaryForDialog ?? runReplaySummaryForDialog)({
          cwd: params.cwd,
          parentSessionId: params.source.previousSessionId,
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

  const seedDraft = buildHappierReplayPromptFromDialog({
    previousSessionId: params.source.previousSessionId,
    strategy: effectiveStrategy,
    recentMessagesCount: params.recentMessagesCount,
    summaryText,
    dialog: hydrated.dialog,
    maxPromptChars: params.maxSeedChars,
  }).trim();

  if (!seedDraft) return null;

  return {
    seedDraft,
    dialog: hydrated.dialog,
    summaryText,
    sourceCutoffSeqInclusive: hydrated.sourceCutoffSeqInclusive,
  };
}
