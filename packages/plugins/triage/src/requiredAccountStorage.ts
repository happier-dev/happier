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
 * Triage declares Account storage as required. The host normally refuses an
 * invocation before it reaches this plugin when that capability is unavailable;
 * this explicit guard keeps a malformed direct invocation typed and fail-closed.
 */
export function requireTriageAccountStorage(
  context: AccountStorageConsumerContext,
): PluginAccountStorageScope {
  const accountStorage = context.services.storage.account;
  if (accountStorage === undefined) {
    throw new PluginError({
      code: 'triage_account_storage_unavailable',
      message: 'Triage requires admitted Account storage.',
    });
  }
  return accountStorage;
}
