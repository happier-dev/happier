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
  const shouldApplySeed = Boolean(seed && seed.seedText && !seed.appliedToLocalId);
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
}>): Promise<{ providerPrompt: string; seedApplied: boolean; seedText: string }> {
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

  if (seedResolution.shouldConsumeSeed) {
    try {
      await params.session.updateMetadata(createReplaySeedV1ConsumeUpdater({ localId: params.localId, nowMs: params.nowMs }));
    } catch {
      // Best-effort: avoid blocking the turn if metadata updates are unavailable.
    }
  }

  return {
    providerPrompt: seedResolution.providerPrompt,
    seedApplied: seedResolution.shouldConsumeSeed,
    seedText: seedResolution.seedText,
  };
}
