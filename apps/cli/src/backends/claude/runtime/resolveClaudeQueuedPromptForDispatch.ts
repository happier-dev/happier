import {
  resolveProviderPromptForDispatch,
  type ProviderPromptDispatchSession,
} from '@/agent/runtime/prompt/resolveProviderPromptForDispatch';
import type { ReplaySeedSettlementResultV1 } from '@/agent/runtime/replaySeed/replaySeedV1';
import type { EnhancedMode } from '@/backends/claude/loop';
import { parseSpecialCommand } from '@happier-dev/protocol';
import { parseCheckpointsCommand, parseRewindCommand } from '@/backends/claude/remote/agentSdk/claudeAgentSdkSlashCommands';

/** Claude's single adapter from a raw queued message to the exact provider prompt. */
export async function resolveClaudeQueuedPromptForDispatch(params: Readonly<{
  sessionClient: ProviderPromptDispatchSession;
  batch: Readonly<{
    message: string;
    providerPromptMeta?: unknown;
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
  // Local handlers consume the raw command grammar, not model-facing context.
  // Reuse their parsers; /compact and other provider commands still finalize normally.
  const localCommand = parseSpecialCommand(params.batch.message).type === 'clear'
    || parseCheckpointsCommand(params.batch.message) !== null
    || parseRewindCommand(params.batch.message) !== null;
  const resolution = await resolveProviderPromptForDispatch({
    session: params.sessionClient,
    userText: params.batch.message,
    meta: localCommand ? undefined : params.batch.providerPromptMeta,
    allowSeed: !localCommand && params.batch.mode.replaySeedAllowed !== false,
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
