import { describe, expect, it } from 'vitest';

describe('provider settings account artifact', () => {
    it('owns providerSettingsV1 as one opaque account artifact without a competing local owner', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import('./settings');
        const { LOCAL_SETTING_ARTIFACTS } = await import('./registry/local/localSettingDefinitions');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.providerSettingsV1.storageScope).toBe('account');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('providerSettingsV1', undefined);
        expect(LOCAL_SETTING_ARTIFACTS.definitions).not.toHaveProperty('providerSettingsV1');

        const future = { v: 2, opaque: { preserve: true } };
        expect(ACCOUNT_SETTING_ARTIFACTS.shape.providerSettingsV1.parse(future)).toEqual(future);
    });
});
