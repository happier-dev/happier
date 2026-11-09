import { settingsDefaults, settingsParse, type Settings } from '../settings/settings';
import type { AccountSettingsScope } from '../settings/scope/accountSettingsScope';
import { loadAccountSettings, loadActiveAccountSettingsScope } from './accountSettingsPersistence';
import { migrateNewSessionUiState } from './newSessionTargetUiState';
import { loadSettings } from './settingsPersistence';

/** Display-only startup values. Account activation still owns scope and acknowledged version. */
export function loadStartupAccountSettings(): Readonly<{ scope: AccountSettingsScope | null; settings: Settings }> {
    let scope: AccountSettingsScope | null = null;
    try {
        scope = loadActiveAccountSettingsScope();
        const raw = scope ? loadAccountSettings(scope).settings : migrateNewSessionUiState(null, loadSettings().settings);
        return { scope, settings: settingsParse(raw) };
    } catch (error) {
        console.error('Failed to read account settings for startup', error);
        return { scope, settings: settingsDefaults };
    }
}
