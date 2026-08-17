import { resolveProviderPromptForDispatch } from '@/agent/runtime/prompt/resolveProviderPromptForDispatch';
import type { ReplaySeedSettlementResultV1 } from '@/agent/runtime/replaySeed/replaySeedV1';
import type { EnhancedMode } from '@/backends/claude/loop';

export async function resolveClaudeRemoteQueuedPromptWithReplaySeed(params: Readonly<{
  sessionClient: {
    getMetadataSnapshot: () => unknown;
    updateMetadata: (updater: (metadata: any) => any) => void | Promise<void>;
    refreshSessionSnapshotFromServerBestEffort?: (opts?: { reason: 'connect' | 'waitForMetadataUpdate' }) => Promise<void>;
  };
  batch: Readonly<{
    message: string;
    mode: Pick<EnhancedMode, 'localId' | 'replaySeedAllowed'>;
  }>;
  didBootstrap: boolean;
}>): Promise<{
  message: string;
  didBootstrap: boolean;
  seedApplied: boolean;
  /** Call only after Claude accepted this prompt; see the replay-seed owner. */
  settleReplaySeedOnProviderAcceptance: () => Promise<ReplaySeedSettlementResultV1>;
}> {
  // Claude has no structured-input consumer, but prompt finalization has exactly one owner
  // (D-21a): no second module may turn a queued message into a provider prompt.
  const resolution = await resolveProviderPromptForDispatch({
    session: params.sessionClient,
    userText: params.batch.message,
    allowSeed: params.batch.mode.replaySeedAllowed !== false,
    localId: params.batch.mode.localId ?? null,
    nowMs: Date.now(),
    refreshMetadataBeforeRead: !params.didBootstrap,
  });

  return {
    message: resolution.providerPrompt,
    didBootstrap: true,
    seedApplied: resolution.seedApplied,
    settleReplaySeedOnProviderAcceptance: resolution.settleReplaySeedOnProviderAcceptance,
  };
}
