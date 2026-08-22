import type { SessionForkPoint } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { resolveReplaySeedDraft } from '@/session/replay/resolveReplaySeedDraft';
import type { runReplaySummaryForDialog } from '@/session/replay/summary/runReplaySummaryForDialog';
import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionErrorCode,
} from '@/session/shared/spawnSessionContract';
import type { LlmTaskRunnerConfigV1 } from '@happier-dev/protocol';

/**
 * The single place a Replay seed becomes Session-creation input.
 *
 * Every Replay-seeded ingress — `session.spawn_new` + `sourceContext`, the
 * `session.fork` replay branch, and the legacy `session.continueWithReplay`
 * compatibility ingress — resolves its source through this owner and then hands
 * the result to the canonical creator (`createSpawnedSession`). Nothing else
 * composes `forkV1` / `replaySeedV1` / `sessionMediaContinuityV1` for creation.
 *
 * This owner deliberately does NOT create a Session row, choose a creation
 * identity, or settle a spawn outcome. Those belong to the canonical creator.
 */
export type ReplaySeededSpawnRecipeSource = Readonly<{
  sourceSessionId: string;
  forkPoint: SessionForkPoint;
}>;

export type ReplaySeededSpawnRecipe = Readonly<{
  /** Resolved exact cutoff; this becomes immutable child lineage. */
  cutoffSeqInclusive: number;
  seedText: string;
  /** Canonical creation metadata: caller overlay first, canonical envelopes last. */
  metadata: Record<string, unknown>;
  /**
   * Workspace paths the seed referenced. Present so a caller can explain a
   * dropped attachment; the envelope itself is already composed into
   * `metadata` when it was usable for the creating machine.
   */
  referencedSessionMediaWorkspacePaths: readonly string[];
}>;

export type BuildReplaySeededSpawnRecipeResult =
  | Readonly<{ ok: true; recipe: ReplaySeededSpawnRecipe }>
  | Readonly<{ ok: false; errorCode: SpawnSessionErrorCode; errorMessage: string }>;

export type BuildReplaySeededSpawnRecipeParams = Readonly<{
  credentials: StoredCredentials;
  /** Working directory used for seed retrieval, not for creation placement. */
  cwd: string;
  source: ReplaySeededSpawnRecipeSource;
  /** Catalog Agent id recorded as the child's fork `agentHint`. */
  agentHintAgentId: string;
  /** Extra creation metadata merged UNDER the canonical envelopes. */
  extraMetadata?: Record<string, unknown>;
  /**
   * Retrieval strategy. Ingresses that expose an explicit strategy on their wire
   * (the legacy continue-with-replay contract) pass it; the fork branch omits it
   * and keeps deriving it from summary-runner presence.
   */
  strategy?: 'recent_messages' | 'summary_plus_recent';
  /**
   * Cutoff recorded as the child's immutable lineage. Defaults to the cutoff the
   * seed retrieval resolved. The fork ingress pins its own already-effective
   * cutoff here so the persisted lineage keeps naming the exact fork point the
   * fork lifecycle admitted, not a retrieval-resolved neighbour.
   */
  lineageCutoffSeqInclusive?: number;
  /**
   * Released count bound. Absent means the character budget is the only content
   * bound; `null` says so explicitly.
   */
  recentMessagesCount?: number | null;
  maxSeedChars?: number;
  candidateLimit?: number;
  maxTextChars?: number;
  summaryRunner?: LlmTaskRunnerConfigV1 | null;
  /**
   * Media continuity references workspace paths that only exist on the machine
   * that will run the child. A creator that cannot prove the child runs on this
   * machine passes `false` and the envelope is omitted explicitly rather than
   * persisting paths the target cannot open.
   */
  mediaContinuityUsableOnCreatingMachine?: boolean;
  nowMs?: number;
  deps?: Readonly<{ runReplaySummaryForDialog?: typeof runReplaySummaryForDialog }>;
}>;

export async function buildReplaySeededSpawnRecipe(
  params: BuildReplaySeededSpawnRecipeParams,
): Promise<BuildReplaySeededSpawnRecipeResult> {
  const strategy = params.strategy
    ?? (params.summaryRunner ? 'summary_plus_recent' : 'recent_messages');
  const resolvedSeed = await resolveReplaySeedDraft({
    credentials: params.credentials,
    cwd: params.cwd,
    source: {
      kind: 'fork_chain',
      previousSessionId: params.source.sourceSessionId,
      ...(params.source.forkPoint.type === 'seq'
        ? { upToSeqInclusive: params.source.forkPoint.upToSeqInclusive }
        : {}),
    },
    strategy,
    // A caller-supplied count is a released contract and still binds; absent,
    // the character budget is the only bound.
    recentMessagesCount: params.recentMessagesCount ?? null,
    maxSeedChars: typeof params.maxSeedChars === 'number'
      ? params.maxSeedChars
      : configuration.replaySeedMaxChars,
    candidateLimit: params.candidateLimit ?? configuration.replaySeedCandidateLimit,
    ...(typeof params.maxTextChars === 'number' ? { maxTextChars: params.maxTextChars } : {}),
    summaryRunner: params.summaryRunner ?? null,
    ...(params.deps?.runReplaySummaryForDialog
      ? { deps: { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog } }
      : {}),
  });
  if (resolvedSeed.status === 'unavailable') {
    return {
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Unable to hydrate replay dialog from transcript.',
    };
  }
  // A Replay-seeded SPAWN exists to carry context into a new Session, so an
  // empty source leaves it with no reason to exist. (The same-Session
  // transition answers this differently: it has already stopped the source, and
  // an empty source is simply nothing to carry.)
  if (resolvedSeed.status === 'no_source_dialog') {
    return {
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Replay seed draft is empty',
    };
  }

  const seedText = resolvedSeed.seedDraft;

  const cutoffSeqInclusive = typeof params.lineageCutoffSeqInclusive === 'number'
    ? params.lineageCutoffSeqInclusive
    : resolvedSeed.sourceCutoffSeqInclusive;
  const nowMs = typeof params.nowMs === 'number' ? params.nowMs : Date.now();
  const mediaUsable = params.mediaContinuityUsableOnCreatingMachine !== false;
  const referencedSessionMediaWorkspacePaths = resolvedSeed.referencedSessionMediaWorkspacePaths;

  return {
    ok: true,
    recipe: {
      cutoffSeqInclusive,
      seedText,
      referencedSessionMediaWorkspacePaths,
      metadata: {
        ...(params.extraMetadata ?? {}),
        forkV1: {
          v: 1,
          parentSessionId: params.source.sourceSessionId,
          parentCutoffSeqInclusive: cutoffSeqInclusive,
          createdAtMs: nowMs,
          strategy: 'replay',
          agentHint: { agentId: params.agentHintAgentId },
        },
        replaySeedV1: {
          v: 1,
          seedText,
          sourceSessionId: params.source.sourceSessionId,
          sourceCutoffSeqInclusive: cutoffSeqInclusive,
          createdAtMs: nowMs,
        },
        ...(mediaUsable && referencedSessionMediaWorkspacePaths.length > 0
          ? {
            sessionMediaContinuityV1: {
              v: 1,
              sourceSessionId: params.source.sourceSessionId,
              sourceCutoffSeqInclusive: cutoffSeqInclusive,
              referencedWorkspacePaths: referencedSessionMediaWorkspacePaths,
            },
          }
          : {}),
      },
    },
  };
}
