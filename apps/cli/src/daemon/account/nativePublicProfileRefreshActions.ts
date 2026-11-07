import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isActionEnabledByActionsSettings, type ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { PublicProfileOwnerReadV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';

import type { PublicProfileRefreshActions } from './publicProfileRefresh';
import type { startPublicProfileRefresh } from './publicProfileRefresh';
import type { StoredCredentials } from '@/persistence';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readStoredCredentialsForServerId, sameStoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  subscribeActiveAccountSettingsKeys } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

/** The native daemon supplies one captured executor and its Account policy reader. */
export function createNativePublicProfileRefreshActions(params: Readonly<{
  executor: Pick<ReturnType<typeof createActionExecutor>, 'execute'>;
  serverId: string;
  getActionsSettings(): ActionsSettingsV1;
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
      const settings = params.getActionsSettings();
      if (!isActionEnabledByActionsSettings(actionId, settings, context)) {
        return { ok: false, errorCode: 'action_disabled', error: 'action_disabled' };
      }
      // Background maintenance cannot open a present-user approval interaction.
      // The shared policy owner decides whether CLI authorization already exists;
      // the executor independently rechecks admission around prepared effects.
      if (isApprovalRequiredByActionsSettings(actionId, settings, context)) {
        return { ok: false, errorCode: 'approval_required', error: 'approval_required' };
      }
      return await params.executor.execute(actionId, {}, {
        ...context, serverId: params.serverId, authority: 'account_automation',
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
  const isCurrent = async () => {
    observeLifetime();
    return !signal.aborted && configuration.activeServerId === params.serverId
      && sameStoredCredentials(params.credentials, await readStoredCredentialsForServerId(params.serverId));
  };
  const provider = createActionSettingsProvider({ scopeKey, allowEnvironmentOverride: false });
  try {
    const { createCliActionExecutorFromCredentials } = await import('@/session/actions/createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: params.credentials, serverId: params.serverId, serverApiUrl: params.serverHttpBaseUrl,
      actionsSettingsProvider: provider, pluginActionExecutionOwner: 'current_process',
      resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot,
      readCredentials: async () => await isCurrent() ? params.credentials : null,
    });
    if (signal.aborted) unsubscribe();
    return { signal, isCurrent, onError: params.onError,
      actions: createNativePublicProfileRefreshActions({ executor, serverId: params.serverId,
        getActionsSettings: provider.getActionsSettings }),
    };
  } catch (error) {
    retirement.abort();
    unsubscribe();
    throw error;
  }
}
