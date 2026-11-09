import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { PublicProfileOwnerReadV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';

import type { PublicProfileRefreshActions } from './publicProfileRefresh';
import type { startPublicProfileRefresh } from './publicProfileRefresh';
import type { StoredCredentials } from '@/persistence';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  subscribeActiveAccountSettingsKeys } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

/** The captured executor owns policy admission, including explicit Off and Ask. */
export function createNativePublicProfileRefreshActions(params: Readonly<{
  executor: Pick<ReturnType<typeof createActionExecutor>, 'execute'>;
  serverId: string;
}>): PublicProfileRefreshActions {
  return {
    readMaintenanceState: async context => {
      const result = await params.executor.execute('account.public_profile.get', {}, {
        ...context, serverId: params.serverId, authority: 'account_automation',
      });
      if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
      const owner = PublicProfileOwnerReadV1Schema.parse(result.result);
      if (owner.kind !== 'ready' || owner.record.state !== 'published' || owner.record.restriction) {
        return { kind: 'inactive' };
      }
      return { kind: 'published', computedAtMs: owner.record.snapshot?.computedAtMs ?? null };
    },
    refresh: async context => {
      const actionId = 'account.public_profile.refresh';
      return await params.executor.execute(actionId, {}, {
        ...context, serverId: params.serverId, authority: 'account_automation', interactivePresentation: 'unavailable',
      });
    },
  };
}

/** Native daemon custody only; requester Session runtimes never call this factory. */
export async function captureNativePublicProfileRefresh(params: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  serverHttpBaseUrl: string;
  signal: AbortSignal;
  resolveServerFeaturesSnapshot(): CliServerFeaturesSnapshot | undefined;
  onError?: (error: unknown) => void;
}>): Promise<Omit<Parameters<typeof startPublicProfileRefresh>[0], 'scheduler'>> {
  const retirement = new AbortController();
  const signal = AbortSignal.any([params.signal, retirement.signal]);
  const scopeKey = resolveAccountSettingsScopeKey(params.credentials);
  let lifetime = getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey
    ? getActiveAccountSettingsSnapshotLifetimeToken() : null;
  const observeLifetime = () => {
    const snapshot = getActiveAccountSettingsSnapshot();
    if ((snapshot && snapshot.scopeKey !== scopeKey)
      || (lifetime !== null && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetime)) {
      retirement.abort();
    } else if (snapshot?.scopeKey === scopeKey && lifetime === null) {
      lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
    }
  };
  const unsubscribe = subscribeActiveAccountSettingsKeys({}, observeLifetime);
  signal.addEventListener('abort', unsubscribe, { once: true });
  observeLifetime();
  const provider = createActionSettingsProvider({ scopeKey, allowEnvironmentOverride: false });
  try {
    const { createCliActionExecutorFromCredentials } = await import('@/session/actions/createCliActionExecutorFromCredentials');
    const createExecutor = () => createCliActionExecutorFromCredentials({
      credentials: params.credentials, serverId: params.serverId, serverApiUrl: params.serverHttpBaseUrl,
      actionsSettingsProvider: provider, pluginActionExecutionOwner: 'current_process',
      resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot,
      readCredentials: async () => signal.aborted ? null : params.credentials,
    });
    if (signal.aborted) unsubscribe();
    return { signal, onError: params.onError,
      actions: createNativePublicProfileRefreshActions({ executor: {
        execute: (...args) => createExecutor().execute(...args),
      }, serverId: params.serverId }),
    };
  } catch (error) {
    retirement.abort();
    unsubscribe();
    throw error;
  }
}
