import type { TranslationKeyNoParams } from '@/text';
import type { BuiltInThemeProfilePresetId, ThemeProfileV1 } from '@happier-dev/protocol/account/settings/themeProfiles';
export type { BuiltInThemeProfilePresetId, ThemeProfileV1 } from '@happier-dev/protocol/account/settings/themeProfiles';

export type ThemeProfileMode = 'light' | 'dark';

export type CanonicalBaseThemeId = 'light' | 'dark';

export type ThemeProfilePublicTokenId = string;

export type ThemeProfileColorOverrides = Readonly<Record<ThemeProfilePublicTokenId, string>>;

export type ThemeProfileSelectionByMode = Readonly<Record<ThemeProfileMode, string | null>>;

/** Canonical Account ids stay strings; an unpromoted local selection retains its origin. */
export type ThemeProfileDeviceSelectionByMode = Readonly<Record<
    ThemeProfileMode,
    string | Readonly<{ legacyProfileId: string }> | null
>>;


export type ThemeProfilesLocalStateV1 = Readonly<{
    activeProfileIds: ThemeProfileSelectionByMode;
    profiles: readonly ThemeProfileV1[];
}>;

export type ThemeProfilesStateSnapshot = Readonly<{
    themeProfiles: ThemeProfilesLocalStateV1;
    legacyProfileIds: Readonly<Record<string, string>>;
}>;


export type BuiltInThemeProfileDefinition = Readonly<{
    profile: ThemeProfileV1;
    presetId: BuiltInThemeProfilePresetId;
    translationKey: TranslationKeyNoParams;
    preferredMode: ThemeProfileMode;
    cloneable: true;
    editable: false;
    deletable: false;
}>;

/** Private device pending-record intent; never part of Account settings. */
export type ThemeProfileMigrationEdit = Readonly<{
    target: Readonly<{ kind: 'account' | 'legacy'; id: string }>;
    profile: ThemeProfileV1 | null;
}>;

export type ThemeProfileMigrationIntent = Readonly<{
    edits: readonly ThemeProfileMigrationEdit[];
    legacyProfileIds: Readonly<Record<string, string>>;
    acknowledged?: true;
    replaceLibrary?: true;
    /** Predecessor pending records may already represent these backup rows in Account. */
    representedLegacyProfileIds?: Readonly<Record<string, string>>;
    /** Actual identities from an attempted POST, distinct from captured UI provenance. */
    attemptedLegacyProfileIds?: Readonly<Record<string, string>>;
}>;
