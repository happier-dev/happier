import type { Metadata } from '@/api/types';
import { createSessionRuntimeIdentityMetadataUpdater } from '@/agent/runtime/identity';

const updater = createSessionRuntimeIdentityMetadataUpdater('geminiSessionId');

export function maybeUpdateGeminiSessionIdMetadata(params: {
  getGeminiSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: { value: string | null };
}): void {
  updater({
    getSessionId: params.getGeminiSessionId,
    updateHappySessionMetadata: params.updateHappySessionMetadata,
    lastPublished: params.lastPublished,
  });
}
