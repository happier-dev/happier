import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getStorage } from '@/sync/domains/state/storageStore';
import {
    loadPendingAccountSettingsState,
    readPendingAccountSettingsPersistenceMutationToken,
    subscribePendingAccountSettingsPersistenceMutations,
    THEME_PROFILE_MIGRATION_PENDING_KEY,
} from '@/sync/domains/state/accountSettingsPersistence';
import type { StorageSubscriptionScope } from '@/sync/domains/state/storageSubscriptions';
import { resolveAccountThemeProfilesSnapshot } from '@/sync/domains/settings/themeProfiles';
import type { ThemeProfilesLocalStateV1, ThemeProfilesStateSnapshot } from '@/theme/profiles/themeProfileTypes';

const themeProfileScope = {
    settings: ['themeProfiles'],
    localSettings: ['themeProfiles', 'themeProfileSelection', 'themeProfileLegacyAccountScope'],
} satisfies StorageSubscriptionScope;

const pendingThemeKeys = ['themeProfiles', THEME_PROFILE_MIGRATION_PENDING_KEY] as const;

/** The Account library and this device's selection share one key-scoped, read-only view. */
export function useThemeProfilesSnapshot(): ThemeProfilesStateSnapshot {
    const input = getStorage()(useShallow(state => ({
        profiles: state.settings.themeProfiles,
        legacy: state.localSettings.themeProfiles,
        selection: state.localSettings.themeProfileSelection,
        legacyScope: state.localSettings.themeProfileLegacyAccountScope,
        scope: state.settingsScope,
    })), themeProfileScope);
    const scope = input.scope;
    const subscribe = React.useCallback((listener: () => void) => scope
        ? subscribePendingAccountSettingsPersistenceMutations(listener, { scope, keys: pendingThemeKeys })
        : () => {}, [scope]);
    const readPendingToken = React.useCallback(() => scope
        ? readPendingAccountSettingsPersistenceMutationToken(scope, pendingThemeKeys) : null, [scope]);
    const pendingToken = React.useSyncExternalStore(subscribe, readPendingToken, readPendingToken);
    const pending = React.useMemo(() => scope ? loadPendingAccountSettingsState(scope) : null, [scope, pendingToken]);
    return React.useMemo(() => resolveAccountThemeProfilesSnapshot({ ...input,
        pendingProfiles: pending?.settings.themeProfiles, pendingIntent: pending?.themeProfileMigration,
    }), [input, pending]);
}

/** Event-time reads use the same Account, pending checkpoint, and device projection as subscribers. */
export function readThemeProfilesSnapshot(): ThemeProfilesStateSnapshot {
    const state = getStorage().getState();
    const pending = state.settingsScope ? loadPendingAccountSettingsState(state.settingsScope) : null;
    return resolveAccountThemeProfilesSnapshot({
        profiles: state.settings.themeProfiles,
        legacy: state.localSettings.themeProfiles,
        selection: state.localSettings.themeProfileSelection,
        legacyScope: state.localSettings.themeProfileLegacyAccountScope,
        scope: state.settingsScope,
        pendingProfiles: pending?.settings.themeProfiles,
        pendingIntent: pending?.themeProfileMigration,
    });
}

export function useThemeProfiles(): ThemeProfilesLocalStateV1 {
    return useThemeProfilesSnapshot().themeProfiles;
}
