import { describe, expect, it } from 'vitest';

import { LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions';

describe('LOCAL_SETTING_DEFINITIONS theme profiles', () => {
    it('keeps custom theme profiles local-only without profile-content analytics', () => {
        expect(LOCAL_SETTING_DEFINITIONS).toHaveProperty('themeProfiles');
        expect(LOCAL_SETTING_DEFINITIONS.themeProfiles.storageScope).toBe('local');
        expect(LOCAL_SETTING_DEFINITIONS.themeProfiles.analytics).toBeUndefined();
        expect(LOCAL_SETTING_DEFINITIONS.themeProfiles.default).toEqual({
            profiles: [],
            activeProfileIds: { light: null, dark: null },
        });
    });
});
