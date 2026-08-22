import { logger } from '@/ui/logger';

export type ReplaySeedV1 = {
  v: 1;
  seedText: string;
  sourceSessionId: string;
  sourceCutoffSeqInclusive: number;
  createdAtMs: number;
  appliedToLocalId?: string;
  appliedAtMs?: number;
};

const REPLAY_SEED_CONSUMED_SENTINEL_LOCAL_ID = '__replay_seed_consumed__';
const REPLAY_SEED_METADATA_REFRESH_TIMEOUT_MS = 3_000;

/**
 * Was this seed placed for a runtime that has NOT taken custody of it yet?
 *
 * Retirement is what records provider acceptance: the seed's text is blanked
 * and `appliedToLocalId` is stamped the instant the provider accepts the prompt
 * the seed was prefixed to. So an unretired seed is the durable statement that
 * the context it carries was handed over and never accepted, and that one fact
 * has two readers — the prompt owner deciding whether to prefix it again, and
 * the Agent-transition record deciding whether the departing Agent reached a
 * new transcript boundary (`REQ-STATE-03`). They share this predicate rather
 * than each re-deriving "pending" from the same three fields.
 */
export function isReplaySeedV1PendingProviderAcceptance(seed: ReplaySeedV1 | null): boolean {
  return Boolean(seed && seed.seedText && !seed.appliedToLocalId);
}

export function readReplaySeedV1FromMetadata(metadata: unknown): ReplaySeedV1 | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const seed = (metadata as any).replaySeedV1;
  if (!seed || typeof seed !== 'object') return null;
  if ((seed as any).v !== 1) return null;
  if (typeof (seed as any).seedText !== 'string') return null;
  return seed as ReplaySeedV1;
}

export function buildProviderPromptWithReplaySeed(params: Readonly<{
  metadata: unknown;
  userText: string;
  allowSeed: boolean;
}>): { providerPrompt: string; shouldConsumeSeed: boolean; seedText: string } {
  if (!params.allowSeed) {
    return { providerPrompt: params.userText, shouldConsumeSeed: false, seedText: '' };
  }

  const seed = readReplaySeedV1FromMetadata(params.metadata);
  const shouldApplySeed = isReplaySeedV1PendingProviderAcceptance(seed);
  if (!shouldApplySeed) {
    return { providerPrompt: params.userText, shouldConsumeSeed: false, seedText: '' };
  }

  return {
    providerPrompt: `${seed!.seedText}\n\n${params.userText}`,
    shouldConsumeSeed: true,
    seedText: seed!.seedText,
  };
}

export function createReplaySeedV1ConsumeUpdater(params: Readonly<{ localId: string | null; nowMs: number }>) {
  const appliedToLocalId =
    typeof params.localId === 'string' && params.localId
      ? params.localId
      : REPLAY_SEED_CONSUMED_SENTINEL_LOCAL_ID;
  return (current: any) => {
    const currentSeed = readReplaySeedV1FromMetadata(current);
    if (!currentSeed || currentSeed.appliedToLocalId) return current;
    return {
      ...(current as any),
      replaySeedV1: {
        ...currentSeed,
        seedText: '',
        appliedToLocalId,
        appliedAtMs: params.nowMs,
      },
    };
  };
}

function hasNonEmptyMetadataSnapshot(metadata: unknown): boolean {
  return Boolean(
    metadata
    && typeof metadata === 'object'
    && !Array.isArray(metadata)
    && Object.keys(metadata as Record<string, unknown>).length > 0,
  );
}

async function waitForReplaySeedMetadataRefreshBestEffort(refresh: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      refresh.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REPLAY_SEED_METADATA_REFRESH_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

export type ReplaySeedSettlementOutcome = 'settled' | 'not_applied' | 'failed';

export type ResolvedProviderPromptWithReplaySeed = Readonly<{
  providerPrompt: string;
  seedApplied: boolean;
  seedText: string;
  /**
   * Retires the applied replay seed.
   *
   * Call this only once the provider has accepted the prompt. Composing a prompt is not
   * acceptance: several awaited steps separate composition from dispatch, and retiring the
   * seed early loses the whole replay context if any of them throws. A prompt that never
   * reaches the provider therefore keeps its seed for the next attempt.
   *
   * Settlement is idempotent per resolution and never throws; a failed metadata write is
   * reported through the returned outcome and logged, because silently swallowing it lets the
   * same seed be prefixed again on the following turn.
   */
  settleOnProviderAcceptance: () => Promise<ReplaySeedSettlementOutcome>;
}>;

export async function resolveProviderPromptWithReplaySeed(params: Readonly<{
  session: {
    getMetadataSnapshot: () => unknown;
    updateMetadata: (updater: (metadata: any) => any) => void | Promise<void>;
    refreshSessionSnapshotFromServerBestEffort?: (opts?: { reason: 'connect' | 'waitForMetadataUpdate' }) => Promise<void>;
    ensureMetadataSnapshot?: (opts?: { timeoutMs?: number; abortSignal?: AbortSignal }) => Promise<unknown>;
  };
  userText: string;
  allowSeed: boolean;
  localId: string | null;
  nowMs: number;
  refreshMetadataBeforeRead: boolean;
}>): Promise<ResolvedProviderPromptWithReplaySeed> {
  const localMetadata = params.session.getMetadataSnapshot();
  const shouldRefreshBeforeRead = params.refreshMetadataBeforeRead && !hasNonEmptyMetadataSnapshot(localMetadata);

  if (shouldRefreshBeforeRead && typeof params.session.refreshSessionSnapshotFromServerBestEffort === 'function') {
    try {
      await waitForReplaySeedMetadataRefreshBestEffort(
        params.session.refreshSessionSnapshotFromServerBestEffort({ reason: 'waitForMetadataUpdate' }),
      );
    } catch {
      // Best-effort only; avoid blocking on snapshot refresh failures.
    }
  } else if (shouldRefreshBeforeRead && typeof params.session.ensureMetadataSnapshot === 'function') {
    try {
      await params.session.ensureMetadataSnapshot({ timeoutMs: REPLAY_SEED_METADATA_REFRESH_TIMEOUT_MS });
    } catch {
      // Best-effort only; avoid blocking on snapshot ensure failures.
    }
  }

  const seedResolution = buildProviderPromptWithReplaySeed({
    metadata: params.session.getMetadataSnapshot(),
    userText: params.userText,
    allowSeed: params.allowSeed,
  });

  let settled = false;
  const settleOnProviderAcceptance = async (): Promise<ReplaySeedSettlementOutcome> => {
    if (!seedResolution.shouldConsumeSeed) return 'not_applied';
    if (settled) return 'settled';
    try {
      await params.session.updateMetadata(createReplaySeedV1ConsumeUpdater({ localId: params.localId, nowMs: params.nowMs }));
      settled = true;
      return 'settled';
    } catch (error) {
      logger.warn(
        '[replaySeedV1] Failed to retire an accepted replay seed; it may be prefixed again on the next turn',
        error,
      );
      return 'failed';
    }
  };

  return {
    providerPrompt: seedResolution.providerPrompt,
    seedApplied: seedResolution.shouldConsumeSeed,
    seedText: seedResolution.seedText,
    settleOnProviderAcceptance,
  };
}
