import type { ModelPackCatalogEntry } from '@happier-dev/protocol/voice/modelPacks/catalog';

/** Speech pickers consume the catalog's human-readable identity. */
export function formatModelPackDisplayName(entry: Pick<ModelPackCatalogEntry, 'displayName'>): string {
  return entry.displayName;
}
