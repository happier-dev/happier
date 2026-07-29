import { accountSettingsParse, type AccountSettings } from '@happier-dev/protocol';

import { readCredentials } from '@/persistence';
import {
    commitActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { updateAccountSettingsV2WithRetry } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import type { AccountSettingsUpdateV2Deps } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';

import { createAccountSettingsBackedPluginStorageScope } from './storage';

export function readActivePluginAccountSettings(): AccountSettings | null {
    return getActiveAccountSettingsSnapshot()?.settings ?? null;
}

export async function updateActivePluginAccountSettings(
    mutate: (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>,
    deps: Readonly<{
        readCredentials?: typeof readCredentials;
        accountSettingsUpdateDeps?: AccountSettingsUpdateV2Deps;
        nowMs?: () => number;
    }> = {},
): Promise<AccountSettings> {
    const credentials = await (deps.readCredentials ?? readCredentials)();
    if (!credentials) {
        throw new Error('Plugin account settings require authenticated credentials');
    }
    const result = await updateAccountSettingsV2WithRetry({
        credentials,
        mutate,
        deps: deps.accountSettingsUpdateDeps,
    });
    const previous = getActiveAccountSettingsSnapshot();
    const settings = result.settings ?? previous?.settings ?? accountSettingsParse({});
    const committed = commitActiveAccountSettingsSnapshot({
        source: 'network',
        settings,
        settingsVersion: result.version,
        loadedAtMs: deps.nowMs?.() ?? Date.now(),
        settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials),
        scopeKey: resolveAccountSettingsScopeKey(credentials),
    });
    return committed.snapshot.settings;
}

export function createActiveAccountSettingsPluginStorageScope(pluginId: string) {
    return createAccountSettingsBackedPluginStorageScope({
        pluginId,
        getSettings: readActivePluginAccountSettings,
        updateSettings: updateActivePluginAccountSettings,
    });
}
