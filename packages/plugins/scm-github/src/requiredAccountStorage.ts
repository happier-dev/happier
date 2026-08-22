import {
  requireAccountStorage,
  type PluginAccountStorageConsumerContext,
  type PluginAccountStorageScope,
} from '@happier-dev/plugin-sdk/storage';

/**
 * GitHub Automation checkpoints declare Account storage as required. The host normally refuses an invocation
 * before it reaches this plugin when that capability is unavailable; this
 * explicit guard keeps a malformed direct invocation typed and fail-closed.
 *
 * The check itself belongs to the SDK owner (`requireAccountStorage`), which is
 * where the three identical copies of it were consolidated. Only this plugin's
 * error identity is local, because that is the only part that was ever
 * different — and callers assert on it.
 */
export function requireGithubAccountStorage(
  context: PluginAccountStorageConsumerContext,
): PluginAccountStorageScope {
  return requireAccountStorage(context, {
    code: 'github_account_storage_unavailable',
    message: 'GitHub Automation checkpoints require admitted Account storage.',
  });
}
