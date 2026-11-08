import { reconcileProviderConnectionsCatalogV1, type ProviderConnectionsCatalogSnapshotV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

/** Cleanup is independent of the admitted catalog's row authority. */
export function preserveProviderConnectionsCatalogAuthority(
  incumbent: ProviderConnectionsCatalogSnapshotV1 | undefined,
  next: ProviderConnectionsCatalogSnapshotV1,
): ProviderConnectionsCatalogSnapshotV1 {
  return incumbent?.status === 'ready' && next.status === 'ready'
    ? { ...next, catalog: reconcileProviderConnectionsCatalogV1(incumbent.catalog, next.catalog) }
    : next;
}
