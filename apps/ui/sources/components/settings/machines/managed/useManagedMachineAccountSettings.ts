import * as React from 'react';
import type { Settings } from '@/sync/domains/settings/settings';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { subscribeAccountSettingsPersistenceMutations } from '@/sync/domains/state/accountSettingsPersistence';
import { storage } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

export type ManagedMachineAccountSettings = Pick<Settings, 'machineRetentionDefaultsV1' | 'managedMachineCreationEnabled'>;
type SettingsState = Readonly<{
    scopeKey: string; settings: ManagedMachineAccountSettings | null; loading: boolean; error: string | null;
}>;

/** Narrow display projection over the canonical exact-Account settings reader, not another settings store. */
export function useManagedMachineAccountSettings(binding?: ServerCredentialAccountScopeBinding): Readonly<{
    settings: ManagedMachineAccountSettings | null; loading: boolean; error: string | null;
}> {
    const scopeKey = JSON.stringify([binding?.serverId, binding?.accountId, binding?.revision]);
    const [state, setState] = React.useState<SettingsState>({ scopeKey: '', settings: null, loading: false, error: null });
    const [revision, refresh] = React.useReducer(value => value + 1, 0);

    React.useEffect(() => {
        if (!binding) return;
        const unsubscribeHome = subscribeHomeAccountChange(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, binding.serverId) && binding.isCurrent()) refresh();
        });
        const unsubscribePersistence = subscribeAccountSettingsPersistenceMutations(scope => {
            if (areAccountSettingsScopesEqual(scope, binding.scope) && binding.isCurrent()) refresh();
        });
        const unsubscribeStorage = storage.subscribe((next, previous) => {
            if (binding.isCurrent() && areAccountSettingsScopesEqual(next.settingsScope, binding.scope)
                && (next.settings.managedMachineCreationEnabled !== previous.settings.managedMachineCreationEnabled
                    || next.settings.machineRetentionDefaultsV1 !== previous.settings.machineRetentionDefaultsV1
                    || !areAccountSettingsScopesEqual(previous.settingsScope, binding.scope))) refresh();
        });
        return () => { unsubscribeHome(); unsubscribePersistence(); unsubscribeStorage(); };
    }, [binding]);

    React.useEffect(() => {
        if (!binding?.isCurrent()) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => {
            abort.abort();
            setState({ scopeKey, settings: null, loading: false, error: 'action_account_scope_changed' });
        });
        setState({ scopeKey, settings: null, loading: true, error: null });
        void (async () => {
            const account = await captureLazyActionAccountContext(binding.serverId, abort.signal);
            try {
                if (account.accountId !== binding.accountId) throw new Error('action_account_scope_changed');
                const settings = await account.readSettings();
                account.assertCurrent();
                if (!abort.signal.aborted && binding.isCurrent()) setState({ scopeKey, loading: false, error: null,
                    settings: { managedMachineCreationEnabled: settings.managedMachineCreationEnabled,
                        machineRetentionDefaultsV1: settings.machineRetentionDefaultsV1 } });
            } finally { account.dispose(); }
        })().catch(() => {
            if (!abort.signal.aborted && binding.isCurrent()) setState({ scopeKey, settings: null, loading: false, error: 'managed_settings_unavailable' });
        });
        return () => { abort.abort(); retirement.dispose(); };
    }, [binding, scopeKey, revision]);

    if (!binding?.isCurrent()) return { settings: null, loading: false, error: null };
    return state.scopeKey === scopeKey ? state : { settings: null, loading: true, error: null };
}
