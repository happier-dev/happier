import type { ThemeProfileMode, ThemeProfileV1 } from './themeProfileTypes';

export const isThemeProfileAssetAppearance = (value: unknown): value is ThemeProfileMode => value === 'light' || value === 'dark';

export const inferThemeProfileAssetAppearance = (profile: Pick<ThemeProfileV1, 'overrides'>): ThemeProfileMode => {
    const lightCount = Object.keys(profile.overrides.light).length;
    const darkCount = Object.keys(profile.overrides.dark).length;
    return darkCount > lightCount ? 'dark' : 'light';
};

export const resolveThemeProfileAssetAppearance = (profile: Pick<ThemeProfileV1, 'assetAppearance' | 'overrides'>): ThemeProfileMode => (
    isThemeProfileAssetAppearance(profile.assetAppearance) ? profile.assetAppearance : inferThemeProfileAssetAppearance(profile)
);
