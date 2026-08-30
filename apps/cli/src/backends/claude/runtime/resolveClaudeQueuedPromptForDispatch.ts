import {
  resolveProviderPromptForDispatch,
  type ProviderPromptDispatchSession,
} from '@/agent/runtime/prompt/resolveProviderPromptForDispatch';
import type { ReplaySeedSettlementResultV1 } from '@/agent/runtime/replaySeed/replaySeedV1';
import type { EnhancedMode } from '@/backends/claude/loop';

/** Claude's single adapter from a raw queued message to the exact provider prompt. */
export async function resolveClaudeQueuedPromptForDispatch(params: Readonly<{
  sessionClient: ProviderPromptDispatchSession;
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
