import { THEME_PROFILE_SCHEMA_VERSION } from './themeProfileConstants';
import type { BuiltInThemeProfilePresetId, ThemeProfileMode, ThemeProfileV1 } from './themeProfileTypes';

const BUILT_IN_TIMESTAMP = '2026-05-11T00:00:00.000Z';

export const createBuiltInProfile = (
    id: BuiltInThemeProfilePresetId,
    name: string,
    assetAppearance: ThemeProfileMode,
    overrides: ThemeProfileV1['overrides'],
): ThemeProfileV1 => ({
    schemaVersion: THEME_PROFILE_SCHEMA_VERSION,
    id,
    name,
    createdAt: BUILT_IN_TIMESTAMP,
    updatedAt: BUILT_IN_TIMESTAMP,
    base: { light: 'light', dark: 'dark' },
    assetAppearance,
    overrides,
});
