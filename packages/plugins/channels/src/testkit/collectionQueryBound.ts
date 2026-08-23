/**
 * The canonical Account Collection query page bound, restated here for the
 * in-memory Collections the Channels tests use as their storage boundary.
 *
 * The number is deliberately an independent literal rather than an import of
 * `MAX_CHANNEL_ACCOUNT_COLLECTION_QUERY_PAGE_SIZE`: a fake built from the
 * constant the production reader plans against can never fail when that
 * constant is the thing that drifted. It mirrors
 * `PluginCollectionQueryRequestV1Schema.limit`
 * (`packages/protocol/src/plugins/data/collectionsV1.ts`), which the loaded CLI
 * Account-storage adapter parses before transport, so a page size this helper
 * rejects is exactly a page size that never reaches storage in production.
 */
const ACCOUNT_COLLECTION_QUERY_LIMIT_WIRE_MAXIMUM = 200;

/**
 * Rejects a query page size the real wire contract would reject.
 *
 * Every in-memory test Collection calls this before serving rows. Without it a
 * fake happily answers an out-of-range page, which is how an always-invalid
 * production page size stayed green.
 */
export function assertChannelsTestCollectionQueryLimit(limit: unknown): void {
  // An omitted page size is valid on the wire: the request schema defaults it.
  if (limit === undefined) return;
  if (typeof limit !== 'number'
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > ACCOUNT_COLLECTION_QUERY_LIMIT_WIRE_MAXIMUM) {
    throw new Error(
      `Collection query limit ${String(limit)} is outside the 1..${ACCOUNT_COLLECTION_QUERY_LIMIT_WIRE_MAXIMUM} wire bound.`,
    );
  }
}
