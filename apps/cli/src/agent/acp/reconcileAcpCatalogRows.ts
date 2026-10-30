import { isDeepStrictEqual } from 'node:util';

/** Keep unchanged catalog rows shared when a provider replaces a full snapshot. */
export function reconcileAcpCatalogRows<T extends Readonly<{ id: string }>>(
  previous: ReadonlyArray<T> | null | undefined,
  next: ReadonlyArray<T>,
): T[] {
  if (!previous) return [...next];
  const previousById = new Map(previous.map((row) => [row.id, row]));
  return next.map((row) => {
    const retained = previousById.get(row.id);
    return retained && isDeepStrictEqual(retained, row) ? retained : row;
  });
}
