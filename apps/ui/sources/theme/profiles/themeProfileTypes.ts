import type { TranslationKeyNoParams } from '@/text';

export type ThemeProfileMode = 'light' | 'dark';

export type CanonicalBaseThemeId = 'light' | 'dark';

export type ThemeProfilePublicTokenId = string;

export type ThemeProfileColorOverrides = Readonly<Record<ThemeProfilePublicTokenId, string>>;

export type ThemeProfileSelectionByMode = Readonly<Record<ThemeProfileMode, string | null>>;

export type ThemeProfileV1 = Readonly<{
    schemaVersion: 1;
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    base: Readonly<{
        light: 'light';
        dark: 'dark';
    }>;
    assetAppearance?: ThemeProfileMode;
    overrides: Readonly<{
        light: ThemeProfileColorOverrides;
        dark: ThemeProfileColorOverrides;
    }>;
}>;

export type ThemeProfilesLocalStateV1 = Readonly<{
    activeProfileIds: ThemeProfileSelectionByMode;
    profiles: readonly ThemeProfileV1[];
}>;

export type BuiltInThemeProfilePresetId =
    | 'premiumDark'
    | 'pitchDark'
    | 'sunsetDark'
    | 'tokyoNight'
    | 'nightDark'
    | 'classicDark'
    | 'graphiteDark'
    | 'catppuccinMocha'
    | 'catppuccinMacchiato'
    | 'catppuccinFrappe'
    | 'oneDarkPro'
    | 'monokaiPro'
    | 'githubDark'
    | 'darkModern'
    | 'premiumLight'
    | 'paperLight'
    | 'catppuccinLatte'
    | 'githubLight';

export type BuiltInThemeProfileDefinition = Readonly<{
    profile: ThemeProfileV1;
    presetId: BuiltInThemeProfilePresetId;
    translationKey: TranslationKeyNoParams;
    preferredMode: ThemeProfileMode;
    cloneable: true;
    editable: false;
    deletable: false;
}>;
