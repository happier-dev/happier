import { resolveProviderPromptForDispatch } from '@/agent/runtime/prompt/resolveProviderPromptForDispatch';

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
  // Gemini has no structured-input consumer, but prompt finalization has exactly one owner
  // (D-21a): no second module may turn a queued message into a provider prompt.
  const resolution = await resolveProviderPromptForDispatch({
    session: params.sessionClient,
    userText: params.text,
    allowSeed: params.replaySeedAllowed,
    localId: params.localId,
    nowMs: Date.now(),
    refreshMetadataBeforeRead: !params.didBootstrap,
  });

  return { text: resolution.providerPrompt, didBootstrap: true };
}

