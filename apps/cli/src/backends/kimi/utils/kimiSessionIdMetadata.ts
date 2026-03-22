import type { Metadata } from '@/api/types';
import { createProviderSessionIdMetadataUpdater } from '@/backends/shared/createProviderSessionIdMetadataUpdater';

const updater = createProviderSessionIdMetadataUpdater('kimiSessionId');

export function maybeUpdateKimiSessionIdMetadata(params: {
  getKimiSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: { value: string | null };
}): void {
  updater({
    getSessionId: params.getKimiSessionId,
    updateHappySessionMetadata: params.updateHappySessionMetadata,
    lastPublished: params.lastPublished,
  });
}
