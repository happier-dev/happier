import type { Metadata } from '@/api/types';
import { createProviderSessionIdMetadataUpdater } from '@/backends/shared/createProviderSessionIdMetadataUpdater';

const updater = createProviderSessionIdMetadataUpdater('qwenSessionId');

export function maybeUpdateQwenSessionIdMetadata(params: {
  getQwenSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: { value: string | null };
}): void {
  updater({
    getSessionId: params.getQwenSessionId,
    updateHappySessionMetadata: params.updateHappySessionMetadata,
    lastPublished: params.lastPublished,
  });
}
