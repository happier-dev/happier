import type { Metadata } from '@/api/types';

/**
 * Parameters for the provider session-ID metadata updater returned by the factory.
 *
 * The getter/key names are generic so that every provider can share one implementation.
 */
export type ProviderSessionIdMetadataUpdaterParams = {
  getSessionId: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: { value: string | null };
};

/**
 * Creates a reusable "maybe-update" function for a given provider session-ID metadata key.
 *
 * Every ACP-like provider stores its opaque session ID in `Metadata[key]` using the
 * exact same read-trim-dedup-optimistic-revert pattern.  This factory eliminates the
 * per-provider copy by accepting the metadata key at construction time.
 *
 * @param metadataKey - The `Metadata` property name, e.g. `'qwenSessionId'`.
 */
export function createProviderSessionIdMetadataUpdater(
  metadataKey: keyof Metadata & string,
): (params: ProviderSessionIdMetadataUpdaterParams) => void {
  return function maybeUpdateProviderSessionIdMetadata(params: ProviderSessionIdMetadataUpdaterParams): void {
    const raw = params.getSessionId();
    const next = typeof raw === 'string' ? raw.trim() : '';
    if (!next) return;

    if (params.lastPublished.value === next) return;
    const prev = params.lastPublished.value;
    params.lastPublished.value = next;

    try {
      const res = params.updateHappySessionMetadata((metadata) => ({
        ...metadata,
        [metadataKey]: next,
      }));
      void Promise.resolve(res).catch(() => {
        if (params.lastPublished.value === next) {
          params.lastPublished.value = prev;
        }
      });
    } catch {
      if (params.lastPublished.value === next) {
        params.lastPublished.value = prev;
      }
    }
  };
}
