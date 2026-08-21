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

export type ReplaySeedSettlementResultV1 =
  /** No seed was applied to this prompt, or this resolution already settled. */
  | Readonly<{ status: 'not_applicable' }>
  /** The seed is retired and will not be applied to another prompt. */
  | Readonly<{ status: 'retired' }>
  /** Retirement did not happen; the seed is still live and may be applied again. */
  | Readonly<{ status: 'failed'; error: unknown }>;

export type ResolvedProviderPromptWithReplaySeed = Readonly<{
  providerPrompt: string;
  seedApplied: boolean;
  seedText: string;
  /**
   * Retire the seed. Call this only once the provider has ACCEPTED the prompt this
   * seed was prefixed to.
   *
   * A prompt that was rejected before any provider effect must not call it: the seed
   * is the target runtime's only carry-over context, and retiring it at composition
   * time destroys that context whenever the prompt never reaches the provider.
   *
   * An ambiguous delivery (the effect may or may not have occurred) also does not call
   * it. The seed stays live, so the worst case is the runtime seeing the carry-over
   * context twice — strictly safer than a runtime that receives none of it.
   */
  settleReplaySeedOnProviderAcceptance: () => Promise<ReplaySeedSettlementResultV1>;
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
  if (params.refreshMetadataBeforeRead && typeof params.session.refreshSessionSnapshotFromServerBestEffort === 'function') {
    try {
      await params.session.refreshSessionSnapshotFromServerBestEffort({ reason: 'waitForMetadataUpdate' });
    } catch {
      // Best-effort only; avoid blocking on snapshot refresh failures.
    }
  } else if (params.refreshMetadataBeforeRead && typeof params.session.ensureMetadataSnapshot === 'function') {
    try {
      await params.session.ensureMetadataSnapshot();
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
  const settleReplaySeedOnProviderAcceptance = async (): Promise<ReplaySeedSettlementResultV1> => {
    if (!seedResolution.shouldConsumeSeed || settled) return { status: 'not_applicable' };
    settled = true;
    try {
      await params.session.updateMetadata(createReplaySeedV1ConsumeUpdater({ localId: params.localId, nowMs: params.nowMs }));
      return { status: 'retired' };
    } catch (error) {
      // The seed is still live, so let a later prompt retire it rather than leaving this
      // resolution permanently settled. A silent failure here would either lose the
      // carry-over context or replay it without anyone knowing, so it is reported.
      settled = false;
      logger.warn(
        '[ReplaySeed] Failed to retire the replay seed after provider acceptance; it stays live and may be applied again',
        error,
      );
      return { status: 'failed', error };
    }
  };

  return {
    providerPrompt: seedResolution.providerPrompt,
    seedApplied: seedResolution.shouldConsumeSeed,
    seedText: seedResolution.seedText,
    settleReplaySeedOnProviderAcceptance,
  };
}
