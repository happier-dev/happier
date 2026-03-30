import type { Metadata } from '@/api/types';
import { createProviderSessionIdMetadataUpdater } from '@/backends/shared/createProviderSessionIdMetadataUpdater';

const updater = createProviderSessionIdMetadataUpdater('auggieSessionId');

export function maybeUpdateAuggieSessionIdMetadata(params: {
  getAuggieSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: { value: string | null };
}): void {
  updater({
    getSessionId: params.getAuggieSessionId,
    updateHappySessionMetadata: params.updateHappySessionMetadata,
    lastPublished: params.lastPublished,
  });
}
