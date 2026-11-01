import { describe, expect, it } from 'vitest';

describe('settings registry completeness', () => {
    it('preserves the account background-work attention preference and defaults missing or invalid values to keep working', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS, settingsParse } = await import('./settings');

        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('sessionListBackgroundWorkAttentionModeV1', 'keepWorking');
        expect(settingsParse({})).toHaveProperty('sessionListBackgroundWorkAttentionModeV1', 'keepWorking');
        expect(settingsParse({ sessionListBackgroundWorkAttentionModeV1: 'showUnread' })).toHaveProperty('sessionListBackgroundWorkAttentionModeV1', 'showUnread');
        expect(settingsParse({ sessionListBackgroundWorkAttentionModeV1: 'keepWorkingUnread' })).toHaveProperty('sessionListBackgroundWorkAttentionModeV1', 'keepWorkingUnread');
        expect(settingsParse({ sessionListBackgroundWorkAttentionModeV1: 'keepWorking' })).toHaveProperty('sessionListBackgroundWorkAttentionModeV1', 'keepWorking');
        expect(settingsParse({ sessionListBackgroundWorkAttentionModeV1: 'invalid' })).toHaveProperty('sessionListBackgroundWorkAttentionModeV1', 'keepWorking');
    });

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

    it('enables remembered engine selections as an account session-creation default', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.rememberLastEngineSelectionsV1.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.lastEngineSelectionsByScopeV1.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('rememberLastEngineSelectionsV1', true);
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('lastEngineSelectionsByScopeV1', {});
    });

    it('owns provider usage gauge and usage-limit prompt preferences as account-synced settings', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.sessionProviderUsageGaugeMode.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('sessionProviderUsageGaugeMode', 'auto');
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.sessionProviderUsageGaugeWindowMode.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('sessionProviderUsageGaugeWindowMode', 'most_constrained');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('sessionUsageGaugeLabels', false);
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults.usageLimitRecoverySettingsV1).toMatchObject({
            promptMode: 'standard',
            resumePromptMode: 'standard',
        });
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.usageLimitRecoverySettingsV1.schema.parse({
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'off',
        }).resumePromptMode).toBe('off');
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.usageLimitRecoverySettingsV1.schema.parse({
            v: 1,
            mode: 'auto_wait',
            promptMode: 'standard',
            resumePromptMode: 'custom',
            customResumePrompt: '  Pick the task back up.  ',
        })).toMatchObject({
            resumePromptMode: 'custom',
            customResumePrompt: 'Pick the task back up.',
        });
    });

    it('owns session list ordering mode as an account-synced enum setting', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS, settingsParse } = await import('./settings');
        const { LOCAL_SETTING_ARTIFACTS } = await import('./registry/local/localSettingDefinitions');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.sessionListOrderingModeV1.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('sessionListOrderingModeV1', 'custom');
        expect(LOCAL_SETTING_ARTIFACTS.definitions).not.toHaveProperty('sessionListOrderingModeV1');
        expect(LOCAL_SETTING_ARTIFACTS.defaults).not.toHaveProperty('sessionListOrderingModeV1');
        expect(settingsParse({ sessionListOrderingModeV1: 'created' }).sessionListOrderingModeV1).toBe('created');
        expect(settingsParse({ sessionListOrderingModeV1: 'updated' }).sessionListOrderingModeV1).toBe('updated');
        expect(settingsParse({ sessionListOrderingModeV1: 'invalid' }).sessionListOrderingModeV1).toBe('custom');
    });

    it('owns keyboard shortcut preferences as account-synced settings instead of local-only settings', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');
        const { LOCAL_SETTING_ARTIFACTS } = await import('./registry/local/localSettingDefinitions');
        const syncedKeys = [
            'commandPaletteEnabled',
            'keyboardShortcutsV2Enabled',
            'keyboardSingleKeyShortcutsEnabled',
            'keyboardShortcutOverridesV1',
            'keyboardShortcutDisabledCommandIdsV1',
        ] as const;

        for (const key of syncedKeys) {
            expect(ACCOUNT_SETTING_ARTIFACTS.definitions[key].storageScope).toBe('account');
            expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty(key);
            expect(LOCAL_SETTING_ARTIFACTS.definitions).not.toHaveProperty(key);
            expect(LOCAL_SETTING_ARTIFACTS.defaults).not.toHaveProperty(key);
        }

        expect(LOCAL_SETTING_ARTIFACTS.definitions.sessionMruOrderV1.storageScope).toBe('local');
    });

    it('builds local settings schema and defaults entirely from canonical local setting artifacts', async () => {
        const { LOCAL_SETTING_ARTIFACTS } = await import('./registry/local/localSettingDefinitions');
        const { LocalSettingsSchema, localSettingsDefaults } = await import('./localSettings');
        expect(new Set(Object.keys(LocalSettingsSchema.shape))).toEqual(new Set(Object.keys(LOCAL_SETTING_ARTIFACTS.shape)));
        expect(new Set(Object.keys(localSettingsDefaults))).toEqual(new Set(Object.keys(LOCAL_SETTING_ARTIFACTS.defaults)));
    });
});
