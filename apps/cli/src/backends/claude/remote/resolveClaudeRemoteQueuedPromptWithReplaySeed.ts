import { resolveProviderPromptWithReplaySeed } from '@/agent/runtime/replaySeed/replaySeedV1';
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
}>): Promise<{ message: string; didBootstrap: boolean }> {
  const resolution = await resolveProviderPromptWithReplaySeed({
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
  };
}
