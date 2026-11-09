import { describe, expect, it } from 'vitest';
import { ThemeProfileV1Schema } from '@happier-dev/protocol/account/settings/themeProfiles';
import { themeProfilesStorageBinding } from './themeProfilesSettingBinding';

const profile = ThemeProfileV1Schema.parse({
    schemaVersion: 1, id: 'theme_optional_assets', name: 'Optional assets',
    createdAt: '2026-10-20T12:00:00.000Z', updatedAt: '2026-10-20T12:00:00.000Z',
    base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} },
});

describe('theme profile Settings binding value contract', () => {
    it('accepts the canonical shared profile shape without requiring an optional asset preference', () => {
        expect(themeProfilesStorageBinding.parse({ profiles: [profile],
            activeProfileIds: { light: profile.id, dark: null } }).success).toBe(true);
    });
});
