import { readThemeProfileLegacyAccountScope, writeThemeProfileLegacyAccountScope } from '@/sync/domains/state/themeProfileMigrationUiState';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE } from '@/theme/profiles/themeProfilePersistence';
import type { ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { canUseLegacyThemeProfiles, resolveAccountThemeProfiles } from '@/sync/domains/settings/themeProfiles';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { storage } from '@/sync/domains/state/storageStore';
import { loadPendingAccountSettingsState, savePendingAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { projectThemeProfileMigration } from '@/theme/profiles/themeProfileMigrationEdits';

/** One captured legacy source; the existing Account Settings CAS owns its destination. */
export function captureLegacyThemeProfileMigration(scope: AccountSettingsScope): Readonly<{
    resolve(profiles: readonly ThemeProfileV1[], pendingProfiles?: readonly ThemeProfileV1[]): ThemeProfilesLocalStateV1 | null;
    stage(state: ThemeProfilesLocalStateV1): void;
    acknowledge(state: ThemeProfilesLocalStateV1): void;
    finish(state: ThemeProfilesLocalStateV1): void;
}> | null {
    if (!areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)) return null;
    const initial = loadLocalSettings();
    const legacy = initial.themeProfiles;
    const pending = loadPendingAccountSettingsState(scope);
    let intent = pending.themeProfileMigration;
    if (!canUseLegacyThemeProfiles(readThemeProfileLegacyAccountScope(), scope) || (!intent && legacy.profiles.length === 0)) return null;
    if (!readThemeProfileLegacyAccountScope() && legacy.profiles.length > 0) {
        // Bind before network work so an Account switch cannot import the same source twice.
        writeThemeProfileLegacyAccountScope(scope);
    }
    const isCurrentSource = (latest: ReturnType<typeof loadLocalSettings>) =>
        (areAccountSettingsScopesEqual(readThemeProfileLegacyAccountScope(), scope)
            || (legacy.profiles.length === 0 && readThemeProfileLegacyAccountScope() === null))
        && areAccountSettingsJsonValuesEqual(latest.themeProfiles, legacy);
    let actualLegacyIds: Readonly<Record<string, string>> = intent?.legacyProfileIds ?? {};
    const composed = (profiles: readonly ThemeProfileV1[], selection: typeof initial.themeProfileSelection) =>
        resolveAccountThemeProfiles({ profiles, legacy, selection, legacyScope: scope, scope,
            ...(intent ? { pendingIntent: { ...intent, acknowledged: true, legacyProfileIds: actualLegacyIds }, pendingProfiles: profiles } : {}) });
    return {
        resolve(profiles, pendingProfiles) {
            // An acknowledged editor mutation can consume this backup while an
            // older POST waits. It must not replay that stale source on CAS rebase.
            if (!isCurrentSource(loadLocalSettings())) return null;
            const projected = projectThemeProfileMigration(intent ? profiles : pendingProfiles ?? profiles, legacy, intent,
                intent?.acknowledged ? profiles : pendingProfiles ?? pending.settings.themeProfiles);
            actualLegacyIds = Object.fromEntries(projected.legacyProfileIds);
            return resolveAccountThemeProfiles({ profiles: projected.profiles, legacy,
                selection: initial.themeProfileSelection, legacyScope: scope, scope,
                pendingIntent: { ...(intent ?? { edits: [] }), acknowledged: true, legacyProfileIds: actualLegacyIds },
                pendingProfiles: projected.profiles });
        },
        stage(state) {
            const latest = loadPendingAccountSettingsState(scope);
            intent = { ...(intent ?? { edits: [] }), legacyProfileIds: actualLegacyIds,
                ...(intent?.attemptedLegacyProfileIds ? { attemptedLegacyProfileIds: actualLegacyIds } : {}) };
            savePendingAccountSettings(scope, { ...latest.settings, themeProfiles: [...state.profiles] }, intent);
        },
        acknowledge(state) {
            if (!intent) return;
            const latest = loadPendingAccountSettingsState(scope);
            intent = { ...intent, legacyProfileIds: actualLegacyIds, acknowledged: true,
                ...(intent.attemptedLegacyProfileIds ? { attemptedLegacyProfileIds: actualLegacyIds } : {}) };
            savePendingAccountSettings(scope, { ...latest.settings, themeProfiles: [...state.profiles] }, intent);
        },
        finish(state) {
            const latest = loadLocalSettings();
            if (!isCurrentSource(latest)) return;
            const selection = areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)
                ? composed(state.profiles, latest.themeProfileSelection).activeProfileIds
                : null;
            storage.getState().applyLocalSettings({ themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE,
                ...(selection ? { themeProfileSelection: selection } : {}),
            });
            writeThemeProfileLegacyAccountScope(null);
            if (intent) {
                const pending = loadPendingAccountSettingsState(scope);
                if (areAccountSettingsJsonValuesEqual(pending.themeProfileMigration, intent)) {
                    const remaining = { ...pending.settings };
                    // A newer ordinary pending library write remains pending.
                    if (areAccountSettingsJsonValuesEqual(remaining.themeProfiles, state.profiles)) delete remaining.themeProfiles;
                    savePendingAccountSettings(scope, remaining, null);
                }
            }
        },
    };
}
