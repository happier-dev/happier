import { resolveProviderPromptWithReplaySeed } from '@/agent/runtime/replaySeed/replaySeedV1';

export async function resolveGeminiQueuedPromptWithReplaySeed(params: Readonly<{
  sessionClient: {
    getMetadataSnapshot: () => unknown;
    updateMetadata: (updater: (metadata: any) => any) => void | Promise<void>;
    refreshSessionSnapshotFromServerBestEffort?: (opts?: { reason: 'connect' | 'waitForMetadataUpdate' }) => Promise<void>;
  };
  text: string;
  localId: string | null;
  replaySeedAllowed: boolean;
  didBootstrap: boolean;
}>): Promise<{ text: string; didBootstrap: boolean }> {
  const resolution = await resolveProviderPromptWithReplaySeed({
    session: params.sessionClient,
    userText: params.text,
    allowSeed: params.replaySeedAllowed,
    localId: params.localId,
    nowMs: Date.now(),
    refreshMetadataBeforeRead: !params.didBootstrap,
  });

  return { text: resolution.providerPrompt, didBootstrap: true };
}

