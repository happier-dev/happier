import type { Metadata } from '@/api/types';
import { createProviderSessionIdMetadataUpdater } from '@/backends/shared/createProviderSessionIdMetadataUpdater';

const updater = createProviderSessionIdMetadataUpdater('copilotSessionId');

export function maybeUpdateCopilotSessionIdMetadata(params: {
  getCopilotSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: { value: string | null };
}): void {
  updater({
    getSessionId: params.getCopilotSessionId,
    updateHappySessionMetadata: params.updateHappySessionMetadata,
    lastPublished: params.lastPublished,
  });
}
