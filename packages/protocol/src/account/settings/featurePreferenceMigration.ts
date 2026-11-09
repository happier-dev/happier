export const ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION = 9;

/** Retire experimental Rich defaults before a reader or writer applies current choices. */
export function migrateAccountSettingsFeaturePreferences(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const inputVersion = typeof raw.schemaVersion === 'number'
        ? raw.schemaVersion
        : ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION;
    const next = { ...raw };

    // Fixed promotion boundary: subsequent schema versions must preserve opt-outs.
    if (inputVersion < 9 && raw.featureToggles && typeof raw.featureToggles === 'object' && !Array.isArray(raw.featureToggles)) {
        const toggles = raw.featureToggles as Record<string, unknown>;
        if (toggles['files.markdownRichEditor'] === false) {
            const migrated = { ...toggles };
            delete migrated['files.markdownRichEditor'];
            next.featureToggles = migrated;
        }
    }
    if (inputVersion < ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION) {
        next.schemaVersion = ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION;
    }
    return next;
}
