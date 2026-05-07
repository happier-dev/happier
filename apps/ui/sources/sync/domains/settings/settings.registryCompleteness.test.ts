import { describe, expect, it } from 'vitest';

describe('settings registry completeness', () => {
    it('builds the account settings schema entirely from schema metadata, canonical account artifacts, and provider settings', async () => {
        const { PROVIDER_SETTINGS_SHAPE } = await import('@/agents/providers/registry/providerSettingArtifacts');
        const { ACCOUNT_SETTING_ARTIFACTS, SettingsSchema } = await import('./settings');
        const expectedSchemaKeys = new Set([
            'schemaVersion',
            ...Object.keys(ACCOUNT_SETTING_ARTIFACTS.shape),
            ...Object.keys(PROVIDER_SETTINGS_SHAPE),
        ]);

        expect(new Set(Object.keys(SettingsSchema.shape))).toEqual(expectedSchemaKeys);
    });

    it('builds account settings defaults entirely from schema metadata, canonical account artifacts, and provider settings', async () => {
        const { PROVIDER_SETTINGS_DEFAULTS } = await import('@/agents/providers/registry/providerSettingArtifacts');
        const { ACCOUNT_SETTING_ARTIFACTS, settingsDefaults } = await import('./settings');
        const expectedDefaultKeys = new Set([
            'schemaVersion',
            ...Object.keys(ACCOUNT_SETTING_ARTIFACTS.defaults),
            ...Object.keys(PROVIDER_SETTINGS_DEFAULTS),
        ]);

        expect(new Set(Object.keys(settingsDefaults))).toEqual(expectedDefaultKeys);
    });

    it('owns featureToggles in the canonical account settings artifacts', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions).toHaveProperty('featureToggles');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('featureToggles', {});
    });

    it('owns mobileWorkspaceExperienceV1 as an account-synced setting, not a local-only setting', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');
        const { LOCAL_SETTING_ARTIFACTS } = await import('./registry/local/localSettingDefinitions');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.mobileWorkspaceExperienceV1.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('mobileWorkspaceExperienceV1', 'cockpit');
        expect(LOCAL_SETTING_ARTIFACTS.definitions).not.toHaveProperty('mobileWorkspaceExperienceV1');
        expect(LOCAL_SETTING_ARTIFACTS.defaults).not.toHaveProperty('mobileWorkspaceExperienceV1');
    });

    it('owns lastUsedAgent in canonical account settings instead of the legacy compatibility bucket', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');
        const { ACCOUNT_LEGACY_SETTING_ARTIFACTS } = await import('./registry/account/accountLegacySettingDefinitions');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions).toHaveProperty('lastUsedAgent');
        expect(ACCOUNT_LEGACY_SETTING_ARTIFACTS.definitions).not.toHaveProperty('lastUsedAgent');
    });

    it('enables remembered project session selections as an account session-creation default', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.rememberLastProjectSessionSelections.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('rememberLastProjectSessionSelections', true);
    });

    it('builds local settings schema and defaults entirely from canonical local setting artifacts', async () => {
        const { LOCAL_SETTING_ARTIFACTS } = await import('./registry/local/localSettingDefinitions');
        const { LocalSettingsSchema, localSettingsDefaults } = await import('./localSettings');
        expect(new Set(Object.keys(LocalSettingsSchema.shape))).toEqual(new Set(Object.keys(LOCAL_SETTING_ARTIFACTS.shape)));
        expect(new Set(Object.keys(localSettingsDefaults))).toEqual(new Set(Object.keys(LOCAL_SETTING_ARTIFACTS.defaults)));
    });
});
