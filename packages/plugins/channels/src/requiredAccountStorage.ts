import {
  requireAccountStorage,
  type PluginAccountStorageConsumerContext,
  type PluginAccountStorageScope,
} from '@happier-dev/plugin-sdk/storage';

/**
 * The largest page one Account Collection query may request.
 *
 * The wire contract caps a query `limit` at 200 rows, and unlike the
 * mutation-batch dimensions it is not published through `collection.limits()`,
 * so a plugin cannot read the in-force value and every Channels reader that
 * pages a partition plans against this one number instead of restating it.
 */
export const MAX_CHANNEL_ACCOUNT_COLLECTION_QUERY_PAGE_SIZE = 200;

/**
 * Channels declares Account storage as required. The host normally refuses an invocation
 * before it reaches this plugin when that capability is unavailable; this
 * explicit guard keeps a malformed direct invocation typed and fail-closed.
 *
 * The check itself belongs to the SDK owner (`requireAccountStorage`), which is
 * where the three identical copies of it were consolidated. Only this plugin's
 * error identity is local, because that is the only part that was ever
 * different — and callers assert on it.
 */
export function requireChannelsAccountStorage(
  context: PluginAccountStorageConsumerContext,
): PluginAccountStorageScope {
  return requireAccountStorage(context, {
    code: 'channels_account_storage_unavailable',
    message: 'Channels requires admitted Account storage.',
  });
}
