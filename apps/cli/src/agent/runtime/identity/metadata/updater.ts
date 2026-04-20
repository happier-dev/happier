import type { Metadata } from '@/api/types';

export type SessionRuntimeIdentityMetadataUpdaterParams = {
  getSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: { value: string | null };
  afterUpdate?: (sessionId: string) => Promise<void> | void;
};

export function createSessionRuntimeIdentityMetadataUpdater(
  metadataKey: keyof Metadata & string,
): (params: SessionRuntimeIdentityMetadataUpdaterParams) => void {
  return function maybeUpdateSessionRuntimeIdentityMetadata(params: SessionRuntimeIdentityMetadataUpdaterParams): void {
    const raw = params.getSessionId();
    const next = typeof raw === 'string' ? raw.trim() : '';
    if (!next) return;

    if (params.lastPublished.value === next) return;
    const previousValue = params.lastPublished.value;
    params.lastPublished.value = next;

    try {
      const result = params.updateHappySessionMetadata((metadata) => ({
        ...metadata,
        [metadataKey]: next,
      }));
      void Promise.resolve(result)
        .then(() => params.afterUpdate?.(next))
        .catch(() => {
          if (params.lastPublished.value === next) {
            params.lastPublished.value = previousValue;
          }
        });
    } catch {
      if (params.lastPublished.value === next) {
        params.lastPublished.value = previousValue;
      }
    }
  };
}
