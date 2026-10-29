import type { TranslationKeyNoParams } from '@/text';

export type ThemeProfileMode = 'light' | 'dark';

export type CanonicalBaseThemeId = 'light' | 'dark';

export type ThemeProfilePublicTokenId = string;

export type ThemeProfileColorOverrides = Readonly<Record<ThemeProfilePublicTokenId, string>>;

export type ThemeProfileSelectionByMode = Readonly<Record<ThemeProfileMode, string | null>>;

/** A legacy reference retains its identity until account migration resolves any ID collision. */
export type ThemeProfileStoredSelectionByMode = Readonly<Record<ThemeProfileMode,
    string | Readonly<{ legacyProfileId: string }> | null>>;

export type ThemeProfileMigrationEdit = Readonly<{
    target: Readonly<{ kind: 'account' | 'legacy'; id: string }>;
    profile: ThemeProfileV1 | null;
}>;

export type ThemeProfileMigrationIntent = Readonly<{
    edits: readonly ThemeProfileMigrationEdit[];
    /** The server accepted this migration; retain its identity map until local cleanup completes. */
    acknowledged?: true;
    /** Original legacy ID to the ID the UI displayed when it accepted these edits. */
    legacyProfileIds: Readonly<Record<string, string>>;
    /** Legacy definitions already represented by account-owned rows in the captured view. */
    representedLegacyProfileIds?: Readonly<Record<string, string>>;
    /** Actual IDs chosen by the last CAS attempt, retained if its response is lost. */
    attemptedLegacyProfileIds?: Readonly<Record<string, string>>;
}>;

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
