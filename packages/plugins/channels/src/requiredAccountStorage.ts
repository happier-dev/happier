import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';

type AccountStorageConsumerContext = Readonly<{
  services: Readonly<{
    storage: Readonly<{
      account?: PluginAccountStorageScope;
    }>;
  }>;
}>;

/**
 * Channels declares Account storage as required. The host normally refuses an
 * invocation before it reaches this plugin when that capability is unavailable;
 * this explicit guard keeps a malformed direct invocation typed and fail-closed.
 */
export function requireChannelsAccountStorage(
  context: AccountStorageConsumerContext,
): PluginAccountStorageScope {
  const accountStorage = context.services.storage.account;
  if (accountStorage === undefined) {
    throw new PluginError({
      code: 'channels_account_storage_unavailable',
      message: 'Channels requires admitted Account storage.',
    });
  }
  return accountStorage;
}
