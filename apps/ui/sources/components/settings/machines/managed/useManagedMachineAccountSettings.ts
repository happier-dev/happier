import * as React from 'react';
import type { Settings } from '@/sync/domains/settings/settings';
import type { ServerCredentialAccountScopeBinding, ServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { subscribeScopedAccountSettings } from '@/sync/ops/account/scopedAccountSettings';

export type ManagedMachineAccountSettings = Pick<Settings, 'machineRetentionDefaultsV1' | 'managedMachineCreationEnabled'>;
type SettingsObservation<T> = Readonly<{ settings: T | null; loading: boolean; error: string | null }>;
type SettingsState<T> = SettingsObservation<T> & Readonly<{ scopeKey: string; accountId: string | null }>;
const NO_SETTINGS = Object.freeze({ settings: null, loading: false, error: null });
const MANAGED_SETTINGS_KEYS = ['machineRetentionDefaultsV1', 'managedMachineCreationEnabled'] as const;
const MANAGED_CREATION_KEYS = ['managedMachineCreationEnabled'] as const;
const selectManagedSettings = ({ managedMachineCreationEnabled, machineRetentionDefaultsV1 }: ManagedMachineAccountSettings) => ({
    managedMachineCreationEnabled, machineRetentionDefaultsV1,
});
const selectCreationEnabled = ({ managedMachineCreationEnabled }: Pick<Settings, (typeof MANAGED_CREATION_KEYS)[number]>) => managedMachineCreationEnabled;

export function useManagedMachineAccountSettings(binding: ServerCredentialAccountScopeBinding | null | undefined,
    resolution: ServerCredentialAccountScopeResolution): SettingsObservation<ManagedMachineAccountSettings> {
    return useManagedMachineSettingsProjection(binding, resolution, MANAGED_SETTINGS_KEYS, selectManagedSettings);
}

export function useManagedMachineCreationPreference(binding: ServerCredentialAccountScopeBinding | null | undefined,
    resolution: ServerCredentialAccountScopeResolution): SettingsObservation<boolean> {
    return useManagedMachineSettingsProjection(binding, resolution, MANAGED_CREATION_KEYS, selectCreationEnabled);
}

/**
 * Narrow display projection over the canonical exact-Account settings reader, not another settings store.
 * An exact Home credential/URL refresh can retire the binding and bind the same Account again (the resolution stays
 * `bound` meanwhile): the last answer stays while the replacement reads. Another Account never sees it.
 */
function useManagedMachineSettingsProjection<K extends keyof Settings, T>(
    binding: ServerCredentialAccountScopeBinding | null | undefined,
    resolution: ServerCredentialAccountScopeResolution,
    keys: readonly K[],
    select: (settings: Pick<Settings, K>) => T,
): SettingsObservation<T> {
    const scopeKey = JSON.stringify([binding?.serverId, binding?.accountId, binding?.revision]);
    const [state, setState] = React.useState<SettingsState<T>>({ scopeKey: '', accountId: null, ...NO_SETTINGS });
    React.useEffect(() => {
        if (!binding?.isCurrent()) return;
        const accountId = binding.accountId;
        setState(current => ({ scopeKey, accountId, settings: current.accountId === accountId ? current.settings : null,
            loading: true, error: null }));
        return subscribeScopedAccountSettings(binding, keys, settings => {
            if (!binding.isCurrent()) return;
            setState({ scopeKey, accountId, loading: false,
                error: settings === null ? 'managed_settings_unavailable' : null,
                settings: settings === null ? null : select(settings) });
        });
    }, [binding, keys, scopeKey, select]);

    if (!binding?.isCurrent()) {
        return resolution.kind === 'bound' && state.accountId === resolution.scope.accountId
            ? { settings: state.settings, loading: true, error: null } : NO_SETTINGS;
    }
    return state.scopeKey === scopeKey ? state
        : { settings: state.accountId === binding.accountId ? state.settings : null, loading: true, error: null };
}
