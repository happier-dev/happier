import type { HappierReplayStrategy } from '@happier-dev/agents';
import {
  SPAWN_SESSION_ERROR_CODES,
  type LlmTaskRunnerConfigV1,
  type SessionForkPoint,
  type SpawnSessionErrorCode,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { resolveReplaySeedDraft } from '@/session/replay/resolveReplaySeedDraft';
import type { runReplaySummaryForDialog } from '@/session/replay/summary/runReplaySummaryForDialog';

/**
 * The single place a Replay seed becomes Session-creation input.
 *
 * Every Replay-seeded ingress — the `session.fork` replay branch, the legacy
 * `session.continueWithReplay` ingress (both its machine-RPC and in-process
 * forms), and `session.spawn_new` + `sourceContext` — resolves its source
 * through this owner and hands the result to the canonical creator
 * (`createSpawnedSession`). Nothing else composes `forkV1` / `replaySeedV1`
 * for creation.
 *
 * This owner deliberately does NOT create a Session row, choose a creation
 * identity, or settle a spawn outcome; those belong to the canonical creator.
 *
 * MEDIA CONTINUITY: this tree has no `sessionMediaContinuityV1` envelope — zero
 * references repo-wide — and must not gain one for shape symmetry with the
 * successor. The successor owns that envelope and the machine-locality proof it
 * requires; see the plan's section 6.4.
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
}>;

export type BuildReplaySeededSpawnRecipeResult =
  | Readonly<{ ok: true; recipe: ReplaySeededSpawnRecipe }>
  | Readonly<{ ok: false; errorCode: SpawnSessionErrorCode; errorMessage: string }>;

export type BuildReplaySeededSpawnRecipeParams = Readonly<{
  credentials: Credentials;
  /** Working directory used for seed retrieval, not for creation placement. */
  cwd: string;
  source: ReplaySeededSpawnRecipeSource;
  /**
   * Catalog Agent id recorded as the child's fork hint. The predecessor's
   * persisted vocabulary is `providerHint.providerId`; the successor renamed it
   * to `agentHint.agentId`. Do not rename it here — the persisted shape is a
   * predecessor contract.
   */
  providerHintAgentId: string;
  /**
   * Each ingress keeps its own strategy decision (the continuation ingresses
   * read the requested `replay.strategy`, the fork branch derives it from the
   * presence of a summary runner), so it is supplied rather than re-derived.
   */
  strategy: HappierReplayStrategy;
  /** Extra creation metadata merged UNDER the canonical envelopes. */
  extraMetadata?: Record<string, unknown>;
  /** Caller identity retained in the existing fork lineage for reconciliation. */
  requestId?: string | null;
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
   * Cutoff recorded as the child's immutable lineage. Defaults to the cutoff the
   * seed retrieval resolved. The fork ingress pins its own already-effective
   * cutoff here so persisted lineage keeps naming the exact fork point the fork
   * lifecycle admitted; the two differ for a `latest` fork, where retrieval
   * resolves its own cutoff.
   */
  lineageCutoffSeqInclusive?: number;
  nowMs?: number;
  deps?: Readonly<{ runReplaySummaryForDialog?: typeof runReplaySummaryForDialog }>;
}>;

export async function buildReplaySeededSpawnRecipe(
  params: BuildReplaySeededSpawnRecipeParams,
): Promise<BuildReplaySeededSpawnRecipeResult> {
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
    strategy: params.strategy,
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
  const requestId = typeof params.requestId === 'string' && params.requestId.trim().length > 0
    ? params.requestId.trim()
    : null;

  return {
    ok: true,
    recipe: {
      cutoffSeqInclusive,
      seedText,
      metadata: {
        ...(params.extraMetadata ?? {}),
        forkV1: {
          v: 1,
          parentSessionId: params.source.sourceSessionId,
          parentCutoffSeqInclusive: cutoffSeqInclusive,
          createdAtMs: nowMs,
          strategy: 'replay',
          ...(requestId ? { requestId } : {}),
          providerHint: { providerId: params.providerHintAgentId },
        },
        replaySeedV1: {
          v: 1,
          seedText,
          sourceSessionId: params.source.sourceSessionId,
          sourceCutoffSeqInclusive: cutoffSeqInclusive,
          createdAtMs: nowMs,
        },
      },
    },
  };
}
