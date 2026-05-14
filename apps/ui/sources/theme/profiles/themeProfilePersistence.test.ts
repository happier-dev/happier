import { describe, expect, it } from 'vitest';

import { parseThemeProfilesLocalState } from './themeProfilePersistence';
import type { ThemeProfileV1 } from './themeProfileTypes';

const profile = (id: string): ThemeProfileV1 => ({
    schemaVersion: 1,
    id,
    name: `Profile ${id}`,
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    base: { light: 'light', dark: 'dark' },
    overrides: { light: {}, dark: {} },
});

describe('theme profile persistence', () => {
    it('drops persisted custom profiles that use ids reserved for base themes', () => {
        const result = parseThemeProfilesLocalState({
            activeProfileId: 'light',
            profiles: [profile('light')],
        });

        expect(result.state).toEqual({ activeProfileId: null, profiles: [] });
        expect(result.changed).toBe(true);
    });

    it('drops persisted custom profiles that use the editor route id', () => {
        const result = parseThemeProfilesLocalState({
            activeProfileId: 'new',
            profiles: [profile('new')],
        });

        expect(result.state).toEqual({ activeProfileId: null, profiles: [] });
        expect(result.changed).toBe(true);
    });
});
