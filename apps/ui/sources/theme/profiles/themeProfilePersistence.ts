import { z } from 'zod';

import { THEME_PROFILE_MAX_PROFILES, THEME_PROFILE_SCHEMA_VERSION } from './themeProfileConstants';
import {
    migrateThemeProfileOverrideTokenIds,
    sanitizeThemeProfileOverrides,
    sanitizeThemeProfileName,
    sanitizeThemeProfileOverridesForV1TrustBoundary,
    isRouteSafeThemeProfileId,
    isReservedThemeProfileId,
} from './themeProfileImportExport';
import type { ThemeProfileV1, ThemeProfilesLocalStateV1 } from './themeProfileTypes';
import { getBuiltInThemeProfileDefinition, isBuiltInThemeProfilePresetId } from './builtInThemeProfiles';
import { inferThemeProfileAssetAppearance, isThemeProfileAssetAppearance } from './themeProfileAssetAppearance';

export const DEFAULT_THEME_PROFILES_LOCAL_STATE: ThemeProfilesLocalStateV1 = Object.freeze({
    profiles: [],
    activeProfileId: null,
});

type ParseThemeProfilesLocalStateResult = Readonly<{
    state: ThemeProfilesLocalStateV1;
    changed: boolean;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const stableStringify = (value: unknown): string => JSON.stringify(value);

const parseThemeProfile = (value: unknown): Readonly<{ profile: ThemeProfileV1; changed: boolean }> | null => {
    if (!isRecord(value)) return null;
    if (value.schemaVersion !== THEME_PROFILE_SCHEMA_VERSION) return null;
    if (typeof value.id !== 'string' || value.id.trim().length === 0) return null;
    if (!isRouteSafeThemeProfileId(value.id.trim())) return null;
    if (isReservedThemeProfileId(value.id.trim())) return null;
    const name = sanitizeThemeProfileName(value.name);
    if (!name) return null;
    if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return null;
    if (!isRecord(value.base) || value.base.light !== 'light' || value.base.dark !== 'dark') return null;
    if (!isRecord(value.overrides)) return null;

    const sanitizedOverrides = sanitizeThemeProfileOverridesForV1TrustBoundary({
        light: value.overrides.light,
        dark: value.overrides.dark,
    });
    if (!sanitizedOverrides) return null;

    const profileWithoutAssetAppearance = {
        schemaVersion: THEME_PROFILE_SCHEMA_VERSION,
        id: value.id.trim(),
        name,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        base: { light: 'light', dark: 'dark' },
        overrides: sanitizedOverrides,
    } satisfies Omit<ThemeProfileV1, 'assetAppearance'>;

    const profile: ThemeProfileV1 = {
        ...profileWithoutAssetAppearance,
        assetAppearance: isThemeProfileAssetAppearance(value.assetAppearance)
            ? value.assetAppearance
            : inferThemeProfileAssetAppearance(profileWithoutAssetAppearance),
    };

    return {
        profile,
        changed: stableStringify(profile) !== stableStringify(value),
    };
};

export const parseThemeProfilesLocalState = (value: unknown): ParseThemeProfilesLocalStateResult => {
    if (!isRecord(value) || !Array.isArray(value.profiles)) {
        return { state: DEFAULT_THEME_PROFILES_LOCAL_STATE, changed: value !== undefined };
    }

    const profiles: ThemeProfileV1[] = [];
    let changed = false;
    const seenIds = new Set<string>();

    for (const sourceProfile of value.profiles.slice(0, THEME_PROFILE_MAX_PROFILES)) {
        const parsedProfile = parseThemeProfile(sourceProfile);
        if (!parsedProfile || seenIds.has(parsedProfile.profile.id) || isBuiltInThemeProfilePresetId(parsedProfile.profile.id)) {
            changed = true;
            continue;
        }

        profiles.push(parsedProfile.profile);
        seenIds.add(parsedProfile.profile.id);
        changed = changed || parsedProfile.changed;
    }

    if (value.profiles.length > THEME_PROFILE_MAX_PROFILES) {
        changed = true;
    }

    const activeProfileId = typeof value.activeProfileId === 'string'
        && (seenIds.has(value.activeProfileId) || isBuiltInThemeProfilePresetId(value.activeProfileId))
        ? value.activeProfileId
        : null;
    if (activeProfileId !== value.activeProfileId) {
        changed = true;
    }

    const state: ThemeProfilesLocalStateV1 = { profiles, activeProfileId };
    return {
        state,
        changed: changed || stableStringify(state) !== stableStringify(value),
    };
};

export const migrateThemeProfileLocalStateTokenIds = (state: ThemeProfilesLocalStateV1): ParseThemeProfilesLocalStateResult => {
    let changed = false;
    const profiles = state.profiles.map((profile) => {
        const light = migrateThemeProfileOverrideTokenIds(profile.overrides.light);
        const dark = migrateThemeProfileOverrideTokenIds(profile.overrides.dark);
        if (light.migratedTokenIds.length === 0 && dark.migratedTokenIds.length === 0) {
            return profile;
        }

        changed = true;
        return {
            ...profile,
            overrides: sanitizeThemeProfileOverrides({
                light: light.overrides,
                dark: dark.overrides,
            }),
        };
    });

    return {
        state: { ...state, profiles },
        changed,
    };
};

export const ThemeProfilesLocalStateSchema: z.ZodType<ThemeProfilesLocalStateV1> = z
    .unknown()
    .transform((value) => parseThemeProfilesLocalState(value).state);

export const findThemeProfileById = (
    state: ThemeProfilesLocalStateV1,
    profileId: string | null | undefined,
): ThemeProfileV1 | null => (
    state.profiles.find((profile) => profile.id === profileId)
    ?? (isBuiltInThemeProfilePresetId(profileId) ? getBuiltInThemeProfileDefinition(profileId)?.profile ?? null : null)
);
