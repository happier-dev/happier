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

/**
 * The active Account's privacy choices as this device last acknowledged them, or null while
 * they are not known here yet (no active Account, or no settings version read from its Home).
 * Telemetry stays off until this is known, so a new device never reports with default-on settings.
 */
export function loadStartupAccountPrivacyChoices(): Readonly<{ analyticsOptOut: boolean; crashReportsOptOut: boolean }> | null {
    try {
        const scope = loadActiveAccountSettingsScope();
        if (!scope) return null;
        const loaded = loadAccountSettings(scope);
        if (loaded.version === null) return null;
        const settings = settingsParse(loaded.settings);
        return { analyticsOptOut: settings.analyticsOptOut, crashReportsOptOut: settings.crashReportsOptOut };
    } catch (error) {
        console.error('Failed to read account privacy choices for startup', error);
        return null;
    }
}
