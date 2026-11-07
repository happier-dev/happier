import * as React from 'react';
import type { Settings } from '@/sync/domains/settings/settings';
import type { ServerCredentialAccountScopeBinding, ServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { subscribeScopedAccountSettings } from '@/sync/ops/account/scopedAccountSettings';

export type ManagedMachineAccountSettings = Pick<Settings, 'machineRetentionDefaultsV1' | 'managedMachineCreationEnabled'>;
type SettingsState = Readonly<{
    scopeKey: string; accountId: string | null; settings: ManagedMachineAccountSettings | null; loading: boolean; error: string | null;
}>;
const NO_SETTINGS = Object.freeze({ settings: null, loading: false, error: null });
const MANAGED_SETTINGS_KEYS = ['machineRetentionDefaultsV1', 'managedMachineCreationEnabled'] as const;

/**
 * Narrow display projection over the canonical exact-Account settings reader, not another settings store.
 * An exact Home credential/URL refresh can retire the binding and bind the same Account again (the resolution stays
 * `bound` meanwhile): the last answer stays while the replacement reads. Another Account never sees it.
 */
export function useManagedMachineAccountSettings(binding: ServerCredentialAccountScopeBinding | null | undefined,
    resolution: ServerCredentialAccountScopeResolution): Readonly<{
    settings: ManagedMachineAccountSettings | null; loading: boolean; error: string | null;
}> {
    const scopeKey = JSON.stringify([binding?.serverId, binding?.accountId, binding?.revision]);
    const [state, setState] = React.useState<SettingsState>({ scopeKey: '', accountId: null, settings: null, loading: false, error: null });
    React.useEffect(() => {
        if (!binding?.isCurrent()) return;
        const accountId = binding.accountId;
        setState(current => ({ scopeKey, accountId, settings: current.accountId === accountId ? current.settings : null,
            loading: true, error: null }));
        return subscribeScopedAccountSettings(binding, MANAGED_SETTINGS_KEYS, settings => {
            if (!binding.isCurrent()) return;
            setState({ scopeKey, accountId, loading: false,
                error: settings === null ? 'managed_settings_unavailable' : null,
                settings: settings === null ? null : { managedMachineCreationEnabled: settings.managedMachineCreationEnabled,
                    machineRetentionDefaultsV1: settings.machineRetentionDefaultsV1 } });
        });
    }, [binding, scopeKey]);

    if (!binding?.isCurrent()) {
        return resolution.kind === 'bound' && state.accountId === resolution.scope.accountId
            ? { settings: state.settings, loading: true, error: null } : NO_SETTINGS;
    }
    return state.scopeKey === scopeKey ? state
        : { settings: state.accountId === binding.accountId ? state.settings : null, loading: true, error: null };
}
