import { describe, expect, it } from 'vitest';

describe('settings registry completeness', () => {
    it('builds the account settings schema entirely from schema metadata and canonical account artifacts', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS, SettingsSchema } = await import('./settings');
        const { LOCAL_ACCOUNT_SETTING_ARTIFACTS } = await import('./registry/local/localAccountSettingDefinitions');
        const expectedSchemaKeys = new Set([
            ...Object.keys(ACCOUNT_SETTING_ARTIFACTS.shape),
            ...Object.keys(LOCAL_ACCOUNT_SETTING_ARTIFACTS.shape),
        ]);

        expect(new Set(Object.keys(SettingsSchema.shape))).toEqual(expectedSchemaKeys);
    });

    it('builds account settings defaults entirely from schema metadata and canonical account artifacts', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS, settingsDefaults } = await import('./settings');
        const { LOCAL_ACCOUNT_SETTING_ARTIFACTS } = await import('./registry/local/localAccountSettingDefinitions');
        const { MIGRATED_SESSION_ORGANIZATION_ACCOUNT_SETTING_KEYS } = await import('./parse/accountSettingsLegacyCleanup');
        const expectedDefaultKeys = new Set([
            ...Object.entries(ACCOUNT_SETTING_ARTIFACTS.defaults).flatMap(([key, value]) => (
                value === undefined || MIGRATED_SESSION_ORGANIZATION_ACCOUNT_SETTING_KEYS.has(key)
                    ? []
                    : [key]
            )),
            ...Object.keys(LOCAL_ACCOUNT_SETTING_ARTIFACTS.defaults),
        ]);

        expect(new Set(Object.keys(settingsDefaults))).toEqual(expectedDefaultKeys);
        for (const key of MIGRATED_SESSION_ORGANIZATION_ACCOUNT_SETTING_KEYS) {
            expect(settingsDefaults).not.toHaveProperty(key);
        }
        expect(settingsDefaults).not.toHaveProperty('providerSettingsV1');
        expect(settingsDefaults).not.toHaveProperty('scmIncludeCoAuthoredBy');
    });

    it('owns featureToggles in the canonical account settings artifacts', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions).toHaveProperty('featureToggles');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('featureToggles', {});
    });

    it('keeps last-used session creation state in the device-local Account catalog', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');
        const { LOCAL_ACCOUNT_SETTING_ARTIFACTS } = await import('./registry/local/localAccountSettingDefinitions');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions).not.toHaveProperty('lastUsedAgent');
        expect(LOCAL_ACCOUNT_SETTING_ARTIFACTS.definitions.lastUsedAgent.storageScope).toBe('local');
        expect(LOCAL_ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('lastUsedAgent', null);
    });

    it('enables remembered project session selections by default as an account-scoped setting', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.rememberLastProjectSessionSelections.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('rememberLastProjectSessionSelections', true);
    });

    it('enables remembered engine selections by default as account-scoped settings', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.rememberLastEngineSelectionsV1.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('rememberLastEngineSelectionsV1', true);
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.lastEngineSelectionsByScopeV1.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('lastEngineSelectionsByScopeV1', {});
    });

    it('owns remoteHostsV1 in canonical account settings artifacts', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions).toHaveProperty('remoteHostsV1');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('remoteHostsV1', []);
    });

    it('owns mobileWorkspaceExperienceV1 as an account-synced setting instead of a local-only setting', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');
        const { LOCAL_SETTING_ARTIFACTS } = await import('./registry/local/localSettingDefinitions');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.mobileWorkspaceExperienceV1.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('mobileWorkspaceExperienceV1', 'cockpit');
        expect(LOCAL_SETTING_ARTIFACTS.definitions).not.toHaveProperty('mobileWorkspaceExperienceV1');
        expect(LOCAL_SETTING_ARTIFACTS.defaults).not.toHaveProperty('mobileWorkspaceExperienceV1');
    });

    it('owns animated session-list working text as an account-synced display setting', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');
        const { LOCAL_SETTING_ARTIFACTS } = await import('./registry/local/localSettingDefinitions');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions).toHaveProperty('sessionListWorkingStatusAnimatedTextEnabled');
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.sessionListWorkingStatusAnimatedTextEnabled.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('sessionListWorkingStatusAnimatedTextEnabled', true);
        expect(LOCAL_SETTING_ARTIFACTS.definitions).not.toHaveProperty('sessionListWorkingStatusAnimatedTextEnabled');
        expect(LOCAL_SETTING_ARTIFACTS.defaults).not.toHaveProperty('sessionListWorkingStatusAnimatedTextEnabled');
    });

    it('owns provider usage gauge preferences as account-synced settings', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');
        const { LOCAL_SETTING_ARTIFACTS } = await import('./registry/local/localSettingDefinitions');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.sessionProviderUsageGaugeMode.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('sessionProviderUsageGaugeMode', 'auto');
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.sessionProviderUsageGaugeWindowMode.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('sessionProviderUsageGaugeWindowMode', 'most_constrained');
        expect(LOCAL_SETTING_ARTIFACTS.definitions).not.toHaveProperty('sessionProviderUsageGaugeMode');
        expect(LOCAL_SETTING_ARTIFACTS.definitions).not.toHaveProperty('sessionProviderUsageGaugeWindowMode');
    });

    it('owns generic connected-service auth and provider state settings instead of the old Codex-only setting', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions).toHaveProperty('connectedServicesDefaultAuthByAgentIdV1');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('connectedServicesDefaultAuthByAgentIdV1', {
            v: 1,
            bindingsByAgentId: {},
        });
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions).toHaveProperty('connectedServicesProviderStateSharingSettingsV1');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('connectedServicesProviderStateSharingSettingsV1', {
            v: 1,
            defaults: {
                configMode: 'linked',
                stateMode: 'shared',
            },
            byAgentId: {},
            acknowledgedRisksByAgentId: {},
        });
    });

    it('owns keyboard shortcut preferences as account-synced settings while keeping session MRU local-only', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');
        const { LOCAL_SETTING_ARTIFACTS } = await import('./registry/local/localSettingDefinitions');
        const syncedKeys = [
            'commandPaletteEnabled',
            'keyboardShortcutsV2Enabled',
            'keyboardSingleKeyShortcutsEnabled',
            'keyboardShortcutDisabledCommandIdsV1',
            'keyboardShortcutOverridesV1',
        ] as const;

        for (const key of syncedKeys) {
            expect(ACCOUNT_SETTING_ARTIFACTS.definitions[key].storageScope).toBe('account');
            expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty(key);
            expect(LOCAL_SETTING_ARTIFACTS.definitions).not.toHaveProperty(key);
            expect(LOCAL_SETTING_ARTIFACTS.defaults).not.toHaveProperty(key);
        }
        expect(LOCAL_SETTING_ARTIFACTS.definitions.sessionMruOrderV1.storageScope).toBe('local');
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions).not.toHaveProperty('sessionMruOrderV1');
    });

    it('builds local settings schema and defaults entirely from canonical local setting artifacts', async () => {
        const { LOCAL_SETTING_ARTIFACTS } = await import('./registry/local/localSettingDefinitions');
        const { LocalSettingsSchema, localSettingsDefaults } = await import('./localSettings');
        expect(new Set(Object.keys(LocalSettingsSchema.shape))).toEqual(new Set(Object.keys(LOCAL_SETTING_ARTIFACTS.shape)));
        expect(new Set(Object.keys(localSettingsDefaults))).toEqual(new Set(Object.keys(LOCAL_SETTING_ARTIFACTS.defaults)));
    });
});
