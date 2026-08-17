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
 * GitHub Automation checkpoints declare Account storage as required. The host
 * normally refuses an invocation before it reaches this plugin when that
 * capability is unavailable; this explicit guard keeps a malformed direct
 * invocation typed and fail-closed.
 */
export function requireGithubAccountStorage(
  context: AccountStorageConsumerContext,
): PluginAccountStorageScope {
  const accountStorage = context.services.storage.account;
  if (accountStorage === undefined) {
    throw new PluginError({
      code: 'github_account_storage_unavailable',
      message: 'GitHub Automation checkpoints require admitted Account storage.',
    });
  }
  return accountStorage;
}
